// 云端原始数据层。读取直接来自云数据库；任何写入都必须经过 score 云函数。
// 积分聚合与排名统一由 services/score.js 完成，本文件不缓存或维护总分。

const defaultCloudAdapter = require('./cloud-adapter.js')

const MEMBER_COLORS = ['#5B8DEF', '#8B7CF6', '#53B6A4', '#F39B63']
const CATEGORY_ALIASES = Object.freeze({
  study: 'study',
  sports: 'sports',
  labor: 'labor',
  discipline: 'discipline',
  '学习': 'study',
  '课堂表现': 'study',
  '作业完成': 'study',
  '体育': 'sports',
  '活动贡献': 'sports',
  '劳动': 'labor',
  '卫生值日': 'labor',
  '纪律': 'discipline',
  '纪律提醒': 'discipline'
})

function normalizeCategory(value) {
  const key = String(value == null ? '' : value).trim()
  return CATEGORY_ALIASES[key] || ''
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function emptyData() {
  return {
    version: 3,
    config: { weekStart: 1, privacyMode: 'full', settings: {} },
    groups: [],
    members: [],
    rules: [],
    events: [],
    terms: []
  }
}

function normalizeTimestamp(value, fallback = '') {
  if (!value) return fallback
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString()
  if (value && typeof value === 'object' && value.$date) return new Date(value.$date).toISOString()
  if (value && typeof value === 'object' && (value.seconds !== undefined || value._seconds !== undefined)) {
    const seconds = value.seconds !== undefined ? value.seconds : value._seconds
    return new Date(Number(seconds) * 1000).toISOString()
  }
  const numeric = typeof value === 'number'
    ? (Math.abs(value) < 100000000000 ? value * 1000 : value)
    : value
  const date = new Date(numeric)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

function normalizeError(error, fallbackCode = 'CLOUD_ERROR') {
  const message = errorText(error) || '未知错误'
  const code = error && typeof error === 'object'
    ? (error.code || error.errCode || error.errorCode || fallbackCode)
    : fallbackCode
  return { code, message }
}

// SDK 错误对象的 message/errMsg 有时还会嵌套一层对象；统一展开，
// 避免页面出现无法定位问题的 [object Object]。
function errorText(error, seen = []) {
  if (error === undefined || error === null) return ''
  if (typeof error === 'string') return error
  if (typeof error === 'number' || typeof error === 'boolean') return String(error)
  if (seen.indexOf(error) >= 0) return ''
  const nextSeen = seen.concat(error)
  const fields = ['message', 'errMsg', 'errorMessage', 'reason', 'historyStates', 'detail']
  for (const field of fields) {
    if (error[field] === undefined || error[field] === null) continue
    const value = errorText(error[field], nextSeen)
    if (value) return value
  }
  try {
    const encoded = JSON.stringify(error)
    return encoded && encoded !== '{}' ? encoded : ''
  } catch (e) {
    return ''
  }
}

function normalizeConfig(raw = {}) {
  const config = { ...raw }
  config.id = raw.id || raw._id || ''
  config.weekStart = Number(raw.weekStart !== undefined ? raw.weekStart : raw.week_start) || 1
  config.privacyMode = raw.privacyMode === 'initial' ? 'initial' : 'full'
  config.currentTermId = raw.currentTermId || raw.current_term_id || raw.termId || raw.term_id || ''
  config.current_term_id = config.currentTermId
  config.settings = raw.settings && typeof raw.settings === 'object' ? clone(raw.settings) : {}
  if (!config.settings.badges && raw.badges && typeof raw.badges === 'object') {
    config.settings.badges = clone(raw.badges)
  }
  config.updatedAt = normalizeTimestamp(raw.updatedAt || raw.updated_at, '')

  // 管理员名单只供云函数鉴权，页面数据层不暴露也不允许编辑。
  delete config._id
  delete config._openid
  delete config.managers
  delete config.adminOpenId
  delete config.isAdmin
  delete config.rules
  return config
}

function normalizeGroup(raw = {}, index = 0) {
  const id = raw.id !== undefined
    ? raw.id
    : (raw.group_id !== undefined
      ? raw.group_id
      : (raw.groupId !== undefined ? raw.groupId : (raw._id || `group_${index + 1}`)))
  return {
    ...raw,
    id,
    group_id: id,
    cloudId: raw._id || '',
    name: String(raw.name || raw.label || raw.group || '未分组'),
    active: raw.active !== false,
    sortOrder: Number.isFinite(Number(raw.sort_order !== undefined ? raw.sort_order : raw.sortOrder))
      ? Number(raw.sort_order !== undefined ? raw.sort_order : raw.sortOrder)
      : index
  }
}

function normalizeMember(raw = {}, index = 0, groupMap = {}) {
  // 业务主键必须优先使用自增 id；CloudBase _id 只保留作底层定位。
  const id = raw.id !== undefined
    ? raw.id
    : (raw.student_id !== undefined
      ? raw.student_id
      : (raw.studentId !== undefined ? raw.studentId : (raw._id || index + 1)))
  const groupId = raw.group_id !== undefined
    ? raw.group_id
    : (raw.groupId !== undefined ? raw.groupId : (raw.group || raw.groupName || '未分组'))
  const group = groupMap[String(groupId)]
  const groupName = String(raw.group_name || raw.groupName || raw.group || (group && group.name) || '未分组')
  return {
    ...raw,
    id,
    student_id: id,
    cloudId: raw._id || '',
    name: String(raw.name || ''),
    groupId,
    group_id: groupId,
    group: groupName,
    groupName,
    color: raw.color || raw.avatarColor || MEMBER_COLORS[index % MEMBER_COLORS.length],
    studentNo: raw.studentNo || raw.student_no || '',
    active: raw.active !== false,
    sortOrder: Number.isFinite(Number(raw.sort_order !== undefined ? raw.sort_order : raw.sortOrder))
      ? Number(raw.sort_order !== undefined ? raw.sort_order : raw.sortOrder)
      : index,
    joinedAt: normalizeTimestamp(raw.joined_at || raw.joinedAt || raw.created_at || raw.createdAt, '')
  }
}

function normalizeTerm(raw = {}, index = 0) {
  const id = raw.id !== undefined
    ? raw.id
    : (raw.term_id !== undefined
      ? raw.term_id
      : (raw.termId !== undefined ? raw.termId : (raw._id || `term_${index + 1}`)))
  return {
    ...raw,
    id,
    term_id: id,
    cloudId: raw._id || '',
    name: String(raw.name || raw.termName || raw.term_name || ''),
    startDate: String(raw.start_date || raw.startDate || raw.termStart || ''),
    start_date: String(raw.start_date || raw.startDate || raw.termStart || ''),
    endDate: String(raw.end_date || raw.endDate || raw.termEnd || ''),
    end_date: String(raw.end_date || raw.endDate || raw.termEnd || ''),
    active: raw.active !== false && raw.status !== 'archived',
    status: raw.status || (raw.active === false ? 'archived' : 'active')
  }
}

function normalizeRule(raw = {}, index = 0) {
  const category = normalizeCategory(raw.category || raw.dimension || raw.label) || 'study'
  return {
    ...raw,
    id: raw.id !== undefined ? raw.id : (raw._id || `rule_${index + 1}`),
    label: String(raw.label || ''),
    category,
    icon: String(raw.icon || '✦'),
    defaultDelta: Number(raw.defaultDelta) || 1,
    allowNegative: raw.allowNegative !== false,
    enabled: raw.enabled !== false
  }
}

function normalizeEvent(raw = {}) {
  const occurredAt = normalizeTimestamp(raw.created_at || raw.occurredAt || raw.createdAt, '')
  const createdAt = occurredAt
  const voidedAt = normalizeTimestamp(raw.voided_at || raw.voidedAt || raw.deleted_at || raw.deletedAt, '')
  const memberId = raw.student_id !== undefined
    ? raw.student_id
    : (raw.studentId !== undefined ? raw.studentId : raw.memberId)
  const points = Number(raw.points !== undefined ? raw.points : raw.delta) || 0
  const termId = raw.term_id !== undefined ? raw.term_id : raw.termId
  return {
    ...raw,
    id: raw.id !== undefined ? raw.id : raw._id,
    cloudId: raw._id || '',
    student_id: memberId,
    studentId: memberId,
    memberId,
    points,
    delta: points,
    reason: String(raw.reason || raw.note || ''),
    category: normalizeCategory(raw.category),
    ruleId: raw.rule_id || raw.ruleId || '',
    note: String(raw.note || ''),
    operatorName: String(raw.operator_name || raw.operatorName || '管理员'),
    occurredAt,
    createdAt,
    created_at: createdAt,
    termId,
    term_id: termId,
    deleted: raw.deleted === true || Boolean(raw.deleted_at || raw.deletedAt),
    voided: raw.voided === true || raw.deleted === true || Boolean(voidedAt),
    voidedAt,
    clientRequestId: raw.client_request_id || raw.clientRequestId || ''
  }
}

function dateKey(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const store = {
  data: emptyData(),
  listeners: [],
  adapter: defaultCloudAdapter,
  envId: '',
  classId: '',
  onForbidden: null,
  watcher: null,
  refreshTimer: null,
  refreshQueuedPromise: null,
  initPromise: null,
  refreshPromise: null,
  configVersion: 0,
  realtimePauseDepth: 0,
  realtimePending: false,
  status: {
    loading: false,
    saving: false,
    ready: false,
    error: null,
    lastSyncAt: null
  },

  configure(options = {}) {
    const nextClassId = options.classId || this.classId
    const nextEnvId = options.envId || this.envId
    const targetChanged = (this.classId && nextClassId !== this.classId)
      || (this.envId && nextEnvId !== this.envId)
    if (targetChanged) {
      this.configVersion += 1
      this.stopRealtime()
      this.data = emptyData()
      this.refreshQueuedPromise = null
      this.refreshPromise = null
      this.status = { loading: false, saving: false, ready: false, error: null, lastSyncAt: null }
    }
    this.envId = nextEnvId
    this.classId = nextClassId
    this.adapter = options.adapter || this.adapter || defaultCloudAdapter
    this.onForbidden = typeof options.onForbidden === 'function' ? options.onForbidden : this.onForbidden
    return this
  },

  async init() {
    if (this.status.ready) return this.getSnapshot()
    if (this.initPromise) return this.initPromise
    this.initPromise = this.refresh()
    try {
      return await this.initPromise
    } finally {
      this.initPromise = null
    }
  },

  ensure() {
    return this.data || emptyData()
  },

  getSnapshot() {
    return { ...clone(this.ensure()), status: clone(this.status) }
  },

  getStatus() {
    return clone(this.status)
  },

  getConfig() {
    return clone(this.ensure().config)
  },

  getGroups(includeInactive = true) {
    const groups = this.ensure().groups.filter(item => includeInactive || item.active)
    return clone(groups.slice().sort((a, b) => a.sortOrder - b.sortOrder))
  },

  getMembers(includeInactive = true) {
    const members = this.ensure().members.filter(item => includeInactive || item.active)
    return clone(members.slice().sort((a, b) => a.sortOrder - b.sortOrder))
  },

  getTerms(includeInactive = true) {
    const terms = this.ensure().terms.filter(item => includeInactive || item.active)
    return clone(terms)
  },

  getRules() {
    return clone(this.ensure().rules.filter(rule => rule.enabled !== false))
  },

  getEvents() {
    return clone(this.ensure().events.slice().sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt)))
  },

  subscribe(callback) {
    if (typeof callback !== 'function') return () => {}
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter(item => item !== callback)
    }
  },

  notify() {
    const snapshot = this.getSnapshot()
    const status = snapshot.status
    this.listeners.slice().forEach(callback => {
      try { callback(snapshot, status) } catch (error) {}
    })
  },

  reportError(error, fallbackCode = 'CLOUD_ERROR') {
    this.status.loading = false
    this.status.error = normalizeError(error, fallbackCode)
    this.notify()
    return this.getSnapshot()
  },

  refresh(force = false) {
    if (this.refreshPromise) {
      if (!force) return this.refreshPromise
      // 多路 watch/页面回调同时到达时，只排队一次后续刷新，
      // 不让 force 调用串成一长串全量读取。
      if (!this.refreshQueuedPromise) {
        const active = this.refreshPromise
        let queued
        queued = active.then(
          () => {
            if (this.refreshQueuedPromise === queued) this.refreshQueuedPromise = null
            return this.refresh(false)
          },
          () => {
            if (this.refreshQueuedPromise === queued) this.refreshQueuedPromise = null
            return this.refresh(false)
          }
        )
        this.refreshQueuedPromise = queued
      }
      return this.refreshQueuedPromise
    }

    const request = {
      version: this.configVersion,
      envId: this.envId,
      classId: this.classId
    }
    const task = Promise.resolve().then(() => this.loadFromCloud(request))
    this.refreshPromise = task
    const clearRefresh = () => {
      if (this.refreshPromise === task) this.refreshPromise = null
    }
    // Do not create an unhandled rejection chain just for cleanup.
    task.then(clearRefresh, clearRefresh)
    return task
  },

  async loadFromCloud(request = {}) {
    const version = request.version === undefined ? this.configVersion : request.version
    const envId = request.envId || this.envId
    const classId = request.classId || this.classId
    const isCurrent = () => version === this.configVersion
      && envId === this.envId
      && classId === this.classId
    if (!isCurrent()) return this.getSnapshot()
    if (!this.adapter || !this.adapter.isConfigurationValid(envId, classId)) {
      const error = new Error('云开发尚未配置：请在 app.js 顶部填写 CLOUD_ENV_ID 和 CLASS_ID。')
      error.code = 'CLOUD_NOT_CONFIGURED'
      return this.reportError(error)
    }
    if (!this.adapter.enabled) {
      const error = new Error('云开发尚未初始化，请确认使用正式 AppID 并已开通云开发。')
      error.code = 'CLOUD_NOT_INITIALIZED'
      return this.reportError(error)
    }

    this.status.loading = true
    this.status.error = null
    this.notify()

    try {
      const cloudData = await this.adapter.readClassSnapshot(classId)
      if (!isCurrent()) return this.getSnapshot()
      const groups = (cloudData.groups || []).map(normalizeGroup)
      const groupMap = {}
      groups.forEach(group => { groupMap[String(group.id)] = group })
      const members = (cloudData.students || []).map((member, index) => normalizeMember(member, index, groupMap))
      const rules = (cloudData.rules || []).map(normalizeRule)
      const events = (cloudData.scoreRecords || []).map(normalizeEvent)
      const terms = (cloudData.terms || []).map(normalizeTerm)
      const settings = cloudData.settings && typeof cloudData.settings === 'object'
        ? cloudData.settings
        : (cloudData.config && cloudData.config.settings)
      this.data = {
        version: 3,
        config: normalizeConfig({ ...(cloudData.config || {}), settings: settings || {} }),
        groups,
        members,
        rules,
        events,
        terms
      }
      this.status.loading = false
      this.status.ready = true
      this.status.error = null
      this.status.lastSyncAt = new Date().toISOString()
      this.startRealtime()
      this.notify()
      return this.getSnapshot()
    } catch (error) {
      if (!isCurrent()) return this.getSnapshot()
      this.status.loading = false
      this.status.error = normalizeError(error, 'READ_FAILED')
      this.notify()
      return this.getSnapshot()
    }
  },

  startRealtime() {
    if (this.watcher || !this.status.ready || !this.adapter || !this.adapter.enabled) return
    try {
      this.watcher = this.adapter.watchClass(
        this.classId,
        () => this.scheduleRefresh(),
        error => {
          const detail = errorText(error)
          // Closing a watcher during onHide or a rebind is expected. The SDK
          // reports it through onError, so do not surface it as a network fault.
          if (/UNINIT.*close|close.*CLOSED|CLOSED.*UNINIT|watch.*closed/i.test(detail)) return
          this.status.error = {
            code: 'REALTIME_FAILED',
            message: `实时同步暂时中断：${detail || '请检查网络'}`
          }
          this.notify()
        }
      )
    } catch (error) {
      this.status.error = normalizeError(error, 'REALTIME_FAILED')
      this.notify()
    }
  },

  scheduleRefresh() {
    if (this.realtimePauseDepth > 0) {
      this.realtimePending = true
      return
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      this.refresh(true)
    }, 180)
  },

  // 批量写入时监听回调只记一个待刷新标记，避免每条新增记录都触发
  // 全量快照读取；批处理结束后由调用方统一 refresh(true)。
  pauseRealtime() {
    this.realtimePauseDepth += 1
  },

  resumeRealtime(schedule = true) {
    if (this.realtimePauseDepth > 0) this.realtimePauseDepth -= 1
    if (this.realtimePauseDepth !== 0 || !this.realtimePending) return
    this.realtimePending = false
    if (schedule) this.scheduleRefresh()
  },

  stopRealtime() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    if (this.watcher) {
      try { this.watcher.close() } catch (error) {}
      this.watcher = null
    }
    this.realtimePauseDepth = 0
    this.realtimePending = false
  },

  // 兼容旧页面的方法名；实际聚合只发生在 services/score.js。
  getStats(period = 'week') {
    const score = require('./score.js')
    const config = this.ensure().config
    const termId = config.currentTermId || config.current_term_id || undefined
    const result = period === 'week' ? score.getWeekStats(new Date()) : score.getTermStats(termId)
    return { ...result, totalScore: result.total }
  },

  memberPeriodTotal(memberId, period) {
    const stats = this.getStats(period)
    const row = (stats.ranking || []).find(item => String(item.id) === String(memberId))
    return row ? Number(row.total) || 0 : 0
  },

  async runWrite(action, payload, options = {}) {
    if (!this.adapter || !this.adapter.isConfigurationValid(this.envId, this.classId)) {
      const error = new Error('云开发尚未配置：请在 app.js 顶部填写 CLOUD_ENV_ID 和 CLASS_ID。')
      error.code = 'CLOUD_NOT_CONFIGURED'
      this.reportError(error)
      throw error
    }
    if (!this.adapter.enabled) {
      const error = new Error('云开发尚未初始化，请稍后重试。')
      error.code = 'CLOUD_NOT_INITIALIZED'
      this.reportError(error)
      throw error
    }

    const shouldNotify = options.notify !== false
    if (shouldNotify) {
      this.status.saving = true
      this.status.error = null
      this.notify()
    }
    try {
      const result = await this.adapter.callScore(action, { classId: this.classId, ...payload })
      if (options.refresh !== false) await this.refresh(true)
      return result
    } catch (error) {
      if (error && error.code === 'FORBIDDEN') {
        if (typeof this.onForbidden === 'function') {
          try { await this.onForbidden() } catch (identityError) {}
        }
        if (typeof wx !== 'undefined' && wx.showToast) {
          wx.showToast({ title: '没有管理员权限', icon: 'none' })
        }
      }
      this.status.error = normalizeError(error, 'WRITE_FAILED')
      if (shouldNotify) this.notify()
      throw error
    } finally {
      if (shouldNotify) {
        this.status.saving = false
        this.notify()
      }
    }
  },

  addEvent(input = {}) {
    const memberId = input.student_id !== undefined
      ? input.student_id
      : (input.studentId !== undefined ? input.studentId : input.memberId)
    const delta = Number(input.points !== undefined ? input.points : input.delta)
    if (memberId === undefined || memberId === null || memberId === '') throw new Error('请选择学生')
    if (!Number.isInteger(delta) || delta === 0) throw new Error('请输入有效整数分值')
    if (Math.abs(delta) > 20) throw new Error('单次记分不能超过 20 分')
    const member = this.ensure().members.find(item => String(item.id) === String(memberId))
    if (!member) throw new Error('学生不存在')
    const rule = this.ensure().rules.find(item => String(item.id) === String(input.ruleId))
    const category = normalizeCategory(input.category)
      || normalizeCategory(rule && rule.category)
      || normalizeCategory(rule && rule.label)
    if (!category) throw new Error('积分类别无效，请选择学习、体育、劳动或纪律')
    const clientRequestId = input.clientRequestId || uid('req')
    const config = this.ensure().config
    const termId = input.term_id || input.termId || config.current_term_id || config.currentTermId
    if (!termId) throw new Error('尚未配置当前学期，请先创建 terms 文档并设置 classConfig.current_term_id')
    const points = delta > 0 ? Math.round(delta) : -Math.round(Math.abs(delta))
    const createdAt = input.created_at || input.occurredAt || new Date().toISOString()
    return this.runWrite('add', {
      student_id: member.id,
      studentId: member.id,
      memberId: member.id,
      points,
      delta: points,
      reason: String(input.reason || '').trim() || (rule ? rule.label : '课堂记录'),
      category,
      rule_id: input.rule_id || input.ruleId || '',
      ruleId: input.ruleId || '',
      note: String(input.note || '').trim(),
      operatorName: input.operatorName || '管理员',
      created_at: createdAt,
      occurredAt: createdAt,
      term_id: termId,
      termId,
      clientRequestId
    }).then(result => {
      const event = this.ensure().events.find(item => item.clientRequestId === clientRequestId)
      return clone(event || normalizeEvent(result.record || {}))
    })
  },

  voidEvent(eventId) {
    const event = this.ensure().events.find(item => String(item.id) === String(eventId))
    if (!event || event.voided) return Promise.resolve(false)
    return this.runWrite('void', { eventId, clientRequestId: uid('req') }).then(() => true)
  },

  updateEvent(eventId, partial = {}) {
    const event = this.ensure().events.find(item => String(item.id) === String(eventId))
    if (!event || event.voided) throw new Error('记录不存在或已撤销')
    const patch = {}
    if (partial.points !== undefined || partial.delta !== undefined) {
      const points = Number(partial.points !== undefined ? partial.points : partial.delta)
      if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 20) {
        throw new Error('分值必须是 -20 至 20 之间的非零整数')
      }
      patch.points = points
    }
    if (partial.category !== undefined) {
      const category = normalizeCategory(partial.category)
      if (!category) throw new Error('积分类别只能是学习、体育、劳动或纪律')
      patch.category = category
    }
    if (partial.note !== undefined) patch.note = String(partial.note || '').trim()
    if (partial.reason !== undefined) patch.reason = String(partial.reason || '').trim()
    if (partial.created_at !== undefined || partial.occurredAt !== undefined) {
      patch.created_at = partial.created_at || partial.occurredAt
    }
    if (partial.term_id !== undefined || partial.termId !== undefined) {
      patch.term_id = partial.term_id || partial.termId
    }
    if (!Object.keys(patch).length) throw new Error('没有可修改的积分字段')
    return this.runWrite('update', {
      recordId: eventId,
      patch,
      clientRequestId: uid('req')
    }).then(result => clone(normalizeEvent(result.record || { ...event, ...patch })))
  },

  deleteEvent(eventId, reason = '') {
    const event = this.ensure().events.find(item => String(item.id) === String(eventId))
    if (!event || event.deleted) return Promise.resolve(false)
    return this.runWrite('delete', {
      recordId: eventId,
      delete_reason: String(reason || '').trim(),
      clientRequestId: uid('req')
    }).then(() => true)
  },

  // 与云函数 action 命名一致的别名，便于后续管理界面调用。
  updateScore(eventId, partial) { return this.updateEvent(eventId, partial) },
  deleteScore(eventId, reason) { return this.deleteEvent(eventId, reason) },

  updateConfig(partial = {}) {
    const patch = {}
    Object.keys(partial).forEach(key => {
      if (partial[key] === undefined) return
      if (['isAdmin', 'managers', 'adminOpenId', '_id', 'id', 'classId'].includes(key)) return
      patch[key] = partial[key]
    })
    if (!Object.keys(patch).length) return Promise.resolve(this.getConfig())
    return this.runWrite('updateConfig', { patch, config: patch, clientRequestId: uid('req') })
      .then(() => this.getConfig())
  },

  addMember(name, group = '未分组', options = {}) {
    const clean = String(name || '').trim()
    if (!clean) throw new Error('请输入姓名')
    const requestedSortOrder = Number(options && options.sortOrder)
    const colorIndex = Number.isInteger(requestedSortOrder) ? requestedSortOrder : this.ensure().members.length
    const member = {
      name: clean,
      group: String(group || '未分组').trim() || '未分组',
      color: MEMBER_COLORS[Math.max(0, colorIndex) % MEMBER_COLORS.length],
      studentNo: '',
      active: true,
      sortOrder: Number.isInteger(requestedSortOrder) ? requestedSortOrder : this.ensure().members.length,
      clientRequestId: uid('req')
    }
    return this.runWrite('addMember', { ...member, member }, options).then(result => {
      const created = result.member || result.student
      if (created) return clone(normalizeMember(created, this.ensure().members.length - 1))
      const byRequest = this.ensure().members.find(item => item.clientRequestId === member.clientRequestId)
      return clone(byRequest || this.ensure().members[this.ensure().members.length - 1])
    })
  },

  toggleMember(memberId, active) {
    const member = this.ensure().members.find(item => String(item.id) === String(memberId))
    if (!member) return Promise.resolve(false)
    return this.runWrite('toggleMember', {
      memberId,
      active: Boolean(active),
      clientRequestId: uid('req')
    }).then(() => true)
  },

  addRule(label, defaultDelta = 1) {
    const clean = String(label || '').trim()
    if (!clean) throw new Error('请输入规则名称')
    const rule = {
      id: uid('rule'),
      label: clean,
      category: 'study',
      icon: '✦',
      defaultDelta: Number(defaultDelta) || 1,
      allowNegative: true,
      enabled: true
    }
    return this.runWrite('addRule', { rule, ...rule, clientRequestId: uid('req') }).then(result => {
      const created = result.rule || rule
      return clone(normalizeRule(created, this.ensure().rules.length - 1))
    })
  },

  updateRule(ruleId, partial = {}) {
    if (!ruleId) throw new Error('缺少规则 ID')
    const patch = { ...partial }
    delete patch.id
    delete patch._id
    return this.runWrite('updateRule', {
      ruleId,
      patch,
      rule: patch,
      clientRequestId: uid('req')
    }).then(() => {
      const updated = this.ensure().rules.find(item => String(item.id) === String(ruleId))
      return updated ? clone(updated) : null
    })
  },

  exportCsv() {
    const data = this.ensure()
    const members = {}
    data.members.forEach(member => { members[member.id] = member.name })
    const lines = [['时间', '学生', '分值', '类别', '原因', '操作人']]
    data.events.filter(event => !event.voided).forEach(event => {
      lines.push([
        dateKey(event.occurredAt),
        members[event.memberId] || '已归档学生',
        event.delta,
        event.category,
        event.reason,
        event.operatorName
      ])
    })
    return lines.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n')
  }
}

module.exports = store
