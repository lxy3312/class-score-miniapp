// 云端读写的唯一客户端适配层：集合只在这里直读，所有写操作只调用 score 云函数。

// CloudBase 小程序端的 limit 在部分基础库上上限为 20；保持该值才能让
// readAll() 在长名单/流水上稳定翻页，不会因为 SDK 截断 limit 而漏读。
const PAGE_SIZE = 20
const CLASS_SCOPED_COLLECTIONS = Object.freeze([
  'students',
  'groups',
  'terms',
  'settings',
  'scoreRules',
  'scoreRecords'
])

function cloudError(message, code = 'CLOUD_ERROR', cause = null) {
  const error = new Error(message)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function looksLikeMissingDocument(error) {
  const message = String(error && (error.errMsg || error.message) || '')
  // CloudBase 小程序 SDK 对 doc(id).get() 的缺失文档通常返回
  // "cannot find document ... please make sure ..."，而不是简单的
  // "not found"。这类错误在可选设置/规则集合中应当按空数据处理，
  // 否则会把“还没有 settings 文档”误报成整页读取失败。
  return /cannot find document|does not exist|not exist|not found|collection.*missing|不存在|找不到|集合.*不存在/i.test(message)
}

function isPlaceholder(value) {
  const text = String(value || '').trim()
  return !text || /^YOUR_[A-Z0-9_]+$/.test(text)
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null)
}

function clientRequestId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function compatibilityGroup(raw = {}) {
  return {
    ...raw,
    id: firstDefined(raw.id, raw.group_id, raw.groupId, raw._id),
    classId: firstDefined(raw.classId, raw.class_id),
    sortOrder: Number(firstDefined(raw.sortOrder, raw.sort_order, 0)),
    createdAt: firstDefined(raw.createdAt, raw.created_at),
    updatedAt: firstDefined(raw.updatedAt, raw.updated_at)
  }
}

function compatibilityTerm(raw = {}) {
  return {
    ...raw,
    id: firstDefined(raw.id, raw.term_id, raw.termId, raw._id),
    classId: firstDefined(raw.classId, raw.class_id),
    startDate: firstDefined(raw.startDate, raw.start_date),
    endDate: firstDefined(raw.endDate, raw.end_date),
    createdAt: firstDefined(raw.createdAt, raw.created_at),
    updatedAt: firstDefined(raw.updatedAt, raw.updated_at)
  }
}

function compatibilitySettings(raw = {}) {
  return {
    ...raw,
    id: firstDefined(raw.id, raw._id),
    classId: firstDefined(raw.classId, raw.class_id),
    updatedAt: firstDefined(raw.updatedAt, raw.updated_at)
  }
}

function compatibilityStudent(raw = {}, groupById = new Map()) {
  const normalized = {
    ...raw,
    id: firstDefined(raw.id, raw.student_id, raw.studentId, raw._id),
    cloud_id: raw._id,
    classId: firstDefined(raw.classId, raw.class_id),
    groupId: firstDefined(raw.groupId, raw.group_id),
    group: firstDefined(
      raw.group,
      raw.groupName,
      raw.group_name,
      groupById.get(String(firstDefined(raw.group_id, raw.groupId, ''))),
      '未分组'
    ),
    studentNo: firstDefined(raw.studentNo, raw.student_no, ''),
    sortOrder: Number(firstDefined(raw.sortOrder, raw.sort_order, 0)),
    joinedAt: firstDefined(raw.joinedAt, raw.joined_at, raw.created_at),
    createdAt: firstDefined(raw.createdAt, raw.created_at),
    updatedAt: firstDefined(raw.updatedAt, raw.updated_at),
    clientRequestId: firstDefined(raw.clientRequestId, raw.client_request_id, '')
  }

  // 新文档以数字逻辑 id 作为业务主键；CloudBase _id 仅保留在 cloud_id。
  if (Number.isInteger(Number(normalized.id)) && Number(normalized.id) > 0) {
    normalized.id = Number(normalized.id)
    delete normalized._id
  }
  return normalized
}

function compatibilityRecord(raw = {}) {
  return {
    ...raw,
    id: firstDefined(raw.id, raw._id),
    classId: firstDefined(raw.classId, raw.class_id),
    studentId: firstDefined(raw.studentId, raw.student_id),
    memberId: firstDefined(raw.memberId, raw.student_id, raw.studentId),
    groupId: firstDefined(raw.groupId, raw.group_id),
    delta: Number(firstDefined(raw.delta, raw.points, 0)),
    occurredAt: firstDefined(raw.occurredAt, raw.created_at, raw.createdAt),
    createdAt: firstDefined(raw.createdAt, raw.created_at, raw.occurredAt),
    termId: firstDefined(raw.termId, raw.term_id),
    ruleId: firstDefined(raw.ruleId, raw.rule_id, ''),
    operatorName: firstDefined(raw.operatorName, raw.operator_name, '管理员'),
    clientRequestId: firstDefined(raw.clientRequestId, raw.client_request_id, ''),
    voidedAt: firstDefined(raw.voidedAt, raw.voided_at),
    deletedAt: firstDefined(raw.deletedAt, raw.deleted_at)
  }
}

const cloudAdapter = {
  enabled: false,
  envId: '',
  db: null,

  isConfigurationValid(envId, classId) {
    return !isPlaceholder(envId) && !isPlaceholder(classId)
  },

  init(envId, options = {}) {
    if (isPlaceholder(envId)) {
      throw cloudError('未配置云环境：请填写 app.js 顶部的 CLOUD_ENV_ID。', 'CLOUD_NOT_CONFIGURED')
    }
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.database) {
      throw cloudError('当前基础库不支持云开发，请在微信开发者工具中启用云开发并使用正式 AppID。', 'CLOUD_UNAVAILABLE')
    }
    // app.js 负责在 onLaunch 中完成 wx.cloud.init；保留直接调用能力，
    // 方便独立调试适配层时初始化一次。alreadyInitialized 避免重复初始化。
    if (!options.alreadyInitialized) wx.cloud.init({ env: envId, traceUser: true })
    this.envId = envId
    this.db = wx.cloud.database()
    this.enabled = true
    return true
  },

  ensureEnabled() {
    if (!this.enabled || !this.db) {
      throw cloudError('云开发尚未初始化，请检查 app.js 中的 CLOUD_ENV_ID。', 'CLOUD_NOT_INITIALIZED')
    }
  },

  async whoami() {
    this.ensureEnabled()
    let response
    try {
      response = await wx.cloud.callFunction({ name: 'whoami', data: {} })
    } catch (error) {
      throw cloudError('身份识别失败，请检查 whoami 云函数是否已部署。', 'WHOAMI_FAILED', error)
    }
    const result = response && response.result
    if (!result || result.error || result.ok === false) {
      throw cloudError(result && result.message ? result.message : '身份识别失败', result && result.code ? result.code : 'WHOAMI_FAILED')
    }
    return { openid: String(result.openid || ''), isAdmin: result.isAdmin === true }
  },

  async callScore(action, payload = {}) {
    this.ensureEnabled()
    let response
    try {
      response = await wx.cloud.callFunction({ name: 'score', data: { ...payload, action } })
    } catch (error) {
      throw cloudError('连接云端失败，请检查网络后重试。', 'NETWORK_ERROR', error)
    }
    const result = response && response.result
    if (!result || result.ok !== true) {
      const code = result && result.code ? result.code : 'WRITE_FAILED'
      const message = code === 'FORBIDDEN'
        ? '没有管理员权限'
        : (result && result.message ? result.message : '云端写入失败')
      throw cloudError(message, code)
    }
    return result
  },

  async readAll(collectionName, condition) {
    this.ensureEnabled()
    const rows = []
    let offset = 0
    while (true) {
      const result = await this.db.collection(collectionName)
        .where(condition)
        .skip(offset)
        .limit(PAGE_SIZE)
        .get()
      const page = result && Array.isArray(result.data) ? result.data : []
      rows.push(...page)
      if (page.length < PAGE_SIZE) break
      offset += page.length
    }
    return rows
  },

  /**
   * 统计阶段的规范字段使用 class_id；旧版本使用 classId。两种字段只在
   * 读取/迁移层合并，业务统计应优先使用规范字段。
   */
  async readClassCollection(collectionName, classId, options = {}) {
    this.ensureEnabled()
    const rows = []
    const seen = new Set()
    const append = page => {
      page.forEach(row => {
        const key = String(row && (row._id || row.id || JSON.stringify(row)))
        if (!seen.has(key)) {
          seen.add(key)
          rows.push(row)
        }
      })
    }
    const command = this.db.command
    if (command && typeof command.or === 'function') {
      try {
        const page = await this.readAll(collectionName, command.or([{ class_id: classId }, { classId }]))
        append(page)
        return rows
      } catch (error) {
        // Older基础库 may expose database.command without supporting OR in a
        // watched/read query; use the explicit compatibility queries below.
        if (options.optional && looksLikeMissingDocument(error)) return rows
      }
    }
    for (const field of ['class_id', 'classId']) {
      try {
        append(await this.readAll(collectionName, { [field]: classId }))
      } catch (error) {
        if (options.optional && looksLikeMissingDocument(error)) continue
        throw error
      }
    }
    return rows
  },

  async readSettings(classId) {
    this.ensureEnabled()
    try {
      const direct = await this.db.collection('settings').doc(String(classId)).get()
      if (direct && direct.data) return direct.data
    } catch (error) {
      if (!looksLikeMissingDocument(error)) throw error
    }
    try {
      const rows = await this.readClassCollection('settings', classId, { optional: true })
      if (rows.length) return rows[0]
      // 早期设置文档可能只有业务 id，没有 class_id/classId。
      for (const field of ['id']) {
        try {
          const result = await this.db.collection('settings').where({ [field]: classId }).limit(1).get()
          if (result && result.data && result.data.length) return result.data[0]
        } catch (error) {
          if (!looksLikeMissingDocument(error)) throw error
        }
      }
      return null
    } catch (error) {
      if (looksLikeMissingDocument(error)) return null
      throw error
    }
  },

  async readClassSnapshot(classId) {
    this.ensureEnabled()
    if (isPlaceholder(classId)) {
      throw cloudError('未配置班级：请填写 app.js 顶部的 CLASS_ID。', 'CLASS_NOT_CONFIGURED')
    }

    let configResult
    try {
      configResult = await this.db.collection('classConfig').doc(classId).get()
    } catch (error) {
      if (looksLikeMissingDocument(error)) {
        throw cloudError(
          `未找到 classConfig/${classId}。请先创建文档，至少填写 _id、schoolName、className、managers、termName、termStart、termEnd。`,
          'CLASS_CONFIG_MISSING',
          error
        )
      }
      throw cloudError('读取班级配置失败，请检查网络和 classConfig 集合的读取权限。', 'READ_CONFIG_FAILED', error)
    }
    if (!configResult || !configResult.data) {
      throw cloudError(
        `未找到 classConfig/${classId}。请先创建文档，至少填写 _id、schoolName、className、managers、termName、termStart、termEnd。`,
        'CLASS_CONFIG_MISSING'
      )
    }

    const configFields = {
      ...configResult.data,
      classId: firstDefined(configResult.data.classId, configResult.data.class_id, configResult.data._id),
      schoolName: firstDefined(configResult.data.schoolName, configResult.data.school_name),
      className: firstDefined(configResult.data.className, configResult.data.class_name),
      termName: firstDefined(configResult.data.termName, configResult.data.term_name),
      termStart: firstDefined(configResult.data.termStart, configResult.data.term_start),
      termEnd: firstDefined(configResult.data.termEnd, configResult.data.term_end),
      currentTermId: firstDefined(configResult.data.currentTermId, configResult.data.current_term_id)
    }
    const missingFields = ['schoolName', 'className', 'managers']
      .filter(field => configFields[field] === undefined || configFields[field] === null)
    if (missingFields.length) {
      throw cloudError(
        `classConfig/${classId} 缺少字段：${missingFields.join('、')}。请在云开发控制台补齐 schoolName、className、managers（openid 字符串数组）。`,
        'CLASS_CONFIG_INVALID'
      )
    }
    if (!Array.isArray(configFields.managers) || configFields.managers.some(item => typeof item !== 'string')) {
      throw cloudError(
        `classConfig/${classId} 的 managers 必须是 openid 字符串数组，请在云开发控制台修正。`,
        'CLASS_CONFIG_INVALID'
      )
    }

    let students
    let groups
    let terms
    let settings
    let scoreRecords
    let rules
    try {
      ;[students, groups, terms, settings, scoreRecords, rules] = await Promise.all([
        this.readClassCollection('students', classId),
        this.readClassCollection('groups', classId, { optional: true }),
        this.readClassCollection('terms', classId, { optional: true }),
        this.readSettings(classId),
        this.readClassCollection('scoreRecords', classId),
        this.readClassCollection('scoreRules', classId, { optional: true })
      ])
    } catch (error) {
      if (error && error.code) throw error
      throw cloudError('读取班级数据失败，请确认 students、groups、terms、settings、scoreRules、scoreRecords 集合存在且允许所有用户读取。', 'READ_DATA_FAILED', error)
    }

    // 管理员白名单只给云函数鉴权使用，不下发到前端快照，避免把其他管理员
    // 的 openid 暴露给普通浏览者；store 仍会再次做字段清理。
    const config = { ...configFields }
    delete config.managers
    delete config.adminOpenId
    delete config.isAdmin
    const compatibleGroups = (groups || []).map(compatibilityGroup)
    const groupById = new Map(compatibleGroups.map(group => [String(group.id), group.name || group.label || '未分组']))
    return {
      config,
      students: (students || []).map(student => compatibilityStudent(student, groupById)),
      groups: compatibleGroups,
      terms: (terms || []).map(compatibilityTerm),
      settings: compatibilitySettings(settings || config.settings || {}),
      scoreRecords: (scoreRecords || []).map(compatibilityRecord),
      rules: rules || (Array.isArray(config.rules) ? config.rules : [])
    }
  },

  addScore(payload) {
    return this.callScore('add', payload)
  },

  voidScore(classId, eventId) {
    return this.callScore('void', { classId, eventId, clientRequestId: clientRequestId('void') })
  },

  updateScore(classId, recordId, patch) {
    return this.callScore('update', {
      classId,
      recordId,
      patch,
      clientRequestId: `update_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    })
  },

  deleteScore(classId, recordId, reason = '') {
    return this.callScore('delete', {
      classId,
      recordId,
      deleteReason: reason,
      clientRequestId: `delete_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    })
  },

  updateConfig(classId, patch) {
    return this.callScore('updateConfig', { classId, patch, config: patch, clientRequestId: clientRequestId('config') })
  },

  addMember(classId, member) {
    return this.callScore('addMember', { classId, ...member, member, clientRequestId: member && member.clientRequestId || clientRequestId('member') })
  },

  toggleMember(classId, memberId, active) {
    return this.callScore('toggleMember', { classId, memberId, active, clientRequestId: clientRequestId('toggle') })
  },

  addRule(classId, rule) {
    return this.callScore('addRule', { classId, ...rule, rule, clientRequestId: rule && rule.clientRequestId || clientRequestId('rule') })
  },

  updateRule(classId, ruleId, patch) {
    return this.callScore('updateRule', { classId, ruleId, patch, rule: patch, clientRequestId: clientRequestId('rule-update') })
  },

  watchClass(classId, onChange, onError) {
    this.ensureEnabled()
    // CloudBase calls onError when a watcher is intentionally closed. Without
    // this guard, switching tabs/backgrounding the app briefly shows a false
    // "实时同步中断" banner (UNINIT -> CLOSED).
    let closed = false
    const watchers = []
    const handleChange = snapshot => {
      if (!closed && typeof onChange === 'function') onChange(snapshot)
    }
    const handleError = error => {
      if (!closed && typeof onError === 'function') onError(error)
    }
    const watch = query => {
      if (closed) return false
      try {
        const watcher = query.watch({ onChange: handleChange, onError: handleError })
        if (!watcher || typeof watcher.close !== 'function') return false
        watchers.push(watcher)
        return true
      } catch (error) {
        handleError(error)
        return false
      }
    }

    watch(this.db.collection('classConfig').where({ _id: classId }))
    const command = this.db.command
    const watchVariants = (collectionName, variants) => {
      const collection = this.db.collection(collectionName)
      // CloudBase command.or 将兼容字段合并为一个监听，正常运行时只占一条
      // 长连接；老基础库不支持 command.or 时才退回到少量独立监听。
      if (command && typeof command.or === 'function') {
        try {
          if (watch(collection.where(command.or(variants)))) return
        } catch (error) {
          // Fall through to the compatibility queries below.
        }
      }
      variants.forEach(variant => watch(collection.where(variant)))
    }

    watchVariants('settings', [{ _id: classId }, { class_id: classId }, { classId }, { id: classId }])
    CLASS_SCOPED_COLLECTIONS
      .filter(collectionName => collectionName !== 'settings')
      .forEach(collectionName => watchVariants(collectionName, [{ class_id: classId }, { classId }]))

    return {
      close() {
        if (closed) return
        closed = true
        watchers.forEach(watcher => {
          try { watcher.close() } catch (error) {}
        })
        watchers.length = 0
      }
    }
  },

  // 保留旧适配层方法名，便于未迁移页面或调试代码复用。
  watchScoreRecords(classId, onChange, onError) {
    this.ensureEnabled()
    return this.db.collection('scoreRecords').where({ classId }).watch({ onChange, onError })
  }
}

module.exports = cloudAdapter
