/**
 * 班级积分小程序的唯一云端写入口。
 *
 * 客户端只允许直接读取数据库；classConfig、students、groups、terms、
 * settings、scoreRules、scoreRecords、counters 和 auditLogs 的任何写入
 * 都必须通过本函数完成。界面上的管理员判断只用于展示，真正的权限校验
 * 始终由 assertAdmin 执行。
 */
const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const COLLECTIONS = Object.freeze({
  config: 'classConfig',
  students: 'students',
  groups: 'groups',
  terms: 'terms',
  settings: 'settings',
  counters: 'counters',
  rules: 'scoreRules',
  records: 'scoreRecords',
  audit: 'auditLogs'
})

// 统计口径固定为四个维度；任何其他类别必须在云端拒绝，不能只依赖前端限制。
const CATEGORY_SET = new Set(['study', 'sports', 'labor', 'discipline'])

const RESERVED_CONFIG_KEYS = new Set([
  '_id',
  '_openid',
  'classId',
  'class_id',
  'managers',
  'adminOpenId',
  'isAdmin',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at'
])

class ActionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ActionError'
    this.code = code
  }
}

function fail(message, code = 'BAD_REQUEST') {
  return { ok: false, code, message }
}

function cleanString(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength)
}

function asNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function canonicalClassId(document) {
  if (!document) return ''
  return cleanString(document.class_id || document.classId || document.classID, 128)
}

function sameIdentifier(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null
    && String(left) === String(right)
}

function numericLogicalId(value) {
  const number = asNumber(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function hashId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`
}

function canonicalGroupId(classId, groupName) {
  const name = cleanString(groupName, 80)
  if (!name || name === '未分组') return 'ungrouped'
  return hashId('group', `${classId}|${name}`)
}

function missingResource(error) {
  const message = String(error && (error.errMsg || error.message) || '')
  return /does not exist|not exist|不存在|找不到|collection.*not found|集合.*不存在/i.test(message)
}

function validDelta(value) {
  const delta = Number(value)
  return Number.isInteger(delta) && delta !== 0 && Math.abs(delta) <= 20 ? delta : null
}

function isPlainObject(value) {
  if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requirePlainObject(value, fieldName) {
  if (!isPlainObject(value)) throw new ActionError('BAD_REQUEST', `${fieldName} 格式不正确`)
  return value
}

function makeRequestId(openid) {
  return `${openid}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`
}

function publicDocument(document) {
  if (!document) return null
  // 逻辑 id 优先；旧文档没有 id 时再回退到 CloudBase 的 _id。
  return { ...document, id: document.id !== undefined ? document.id : (document._id || '') }
}

async function getDocument(collectionName, documentId) {
  try {
    const result = await db.collection(collectionName).doc(String(documentId)).get()
    return result && result.data ? result.data : null
  } catch (error) {
    return null
  }
}

async function queryOne(collectionName, condition) {
  try {
    const result = await db.collection(collectionName).where(condition).limit(1).get()
    return result && Array.isArray(result.data) && result.data.length ? result.data[0] : null
  } catch (error) {
    if (missingResource(error)) return null
    throw error
  }
}

function belongsToClass(document, classId) {
  return Boolean(document) && sameIdentifier(canonicalClassId(document), classId)
}

function matchesLogicalIdentifier(document, identifier) {
  if (!document) return false
  const numeric = numericLogicalId(identifier)
  if (numeric !== null) return numericLogicalId(document.id) === numeric
  return String(document._id || document.id || '') === String(identifier)
}

/**
 * 兼容旧的 CloudBase _id/classId，也支持统计阶段的逻辑数字 id/class_id。
 * 所有修改积分、学生状态的 action 都通过这里解析目标，避免把别班文档误当成当前班级。
 */
async function findClassDocument(collectionName, identifier, classId, options = {}) {
  const key = cleanString(identifier, 128)
  if (!key) return null

  const direct = await getDocument(collectionName, key)
  if (belongsToClass(direct, classId) && matchesLogicalIdentifier(direct, identifier)) return direct

  const numericId = numericLogicalId(identifier)
  const conditions = []
  const classFields = ['class_id', 'classId']
  classFields.forEach(field => {
    if (numericId !== null) conditions.push({ [field]: classId, id: numericId })
    conditions.push({ [field]: classId, id: key })
    conditions.push({ [field]: classId, _id: key })
    if (collectionName === COLLECTIONS.terms) {
      conditions.push({ [field]: classId, term_id: numericId !== null ? numericId : key })
      conditions.push({ [field]: classId, termId: key })
    }
    if (collectionName === COLLECTIONS.groups) {
      conditions.push({ [field]: classId, group_id: numericId !== null ? numericId : key })
      conditions.push({ [field]: classId, groupId: key })
    }
    if (options.student) {
      conditions.push({ [field]: classId, student_id: numericId !== null ? numericId : key })
      conditions.push({ [field]: classId, studentId: key })
    }
  })

  for (const condition of conditions) {
    const found = await queryOne(collectionName, condition)
    if (belongsToClass(found, classId)) return found
  }
  return null
}

/**
 * 唯一的管理员鉴权实现。managers 必须是 openid 字符串数组；不兼容旧的
 * adminOpenId 字段，避免两个身份来源造成权限漂移。
 */
async function assertAdmin(openid, classId) {
  if (!openid) throw new ActionError('UNAUTHORIZED', '无法获取当前用户身份')
  if (!classId) throw new ActionError('BAD_REQUEST', '缺少 classId')

  const config = await getDocument(COLLECTIONS.config, classId)
  if (!config) {
    throw new ActionError(
      'CLASS_CONFIG_NOT_FOUND',
      '班级配置不存在，请先在云开发控制台创建 classConfig 文档，并填写 schoolName、className、managers（openid 字符串数组）'
    )
  }

  const managers = Array.isArray(config.managers)
    ? config.managers.filter(item => typeof item === 'string')
    : []

  if (!managers.includes(openid)) throw new ActionError('FORBIDDEN', '没有管理员权限')
  return config
}

async function withTransaction(errorMessage, callback) {
  if (typeof db.runTransaction === 'function') {
    try {
      // runTransaction 会在写冲突时自动重试，适合并发分配自增逻辑 id。
      return await db.runTransaction(callback)
    } catch (error) {
      if (error instanceof ActionError) throw error
      console.error(errorMessage, error)
      throw new ActionError('TRANSACTION_FAILED', errorMessage)
    }
  }

  const transaction = await db.startTransaction()
  try {
    const result = await callback(transaction)
    await transaction.commit()
    return result
  } catch (error) {
    await transaction.rollback().catch(() => {})
    if (error instanceof ActionError) throw error
    console.error(errorMessage, error)
    throw new ActionError('TRANSACTION_FAILED', errorMessage)
  }
}

function auditEntry(action, classId, openid, detail = {}) {
  return {
    action,
    class_id: classId,
    classId,
    operator_openid: openid,
    operatorOpenId: openid,
    ...detail,
    created_at: db.serverDate(),
    createdAt: db.serverDate()
  }
}

async function findDuplicate(collectionName, classId, clientRequestId) {
  if (!clientRequestId) return null
  const seen = new Set()
  for (const classField of ['class_id', 'classId']) {
    for (const requestField of ['client_request_id', 'clientRequestId']) {
      try {
        const result = await db.collection(collectionName)
          .where({ [classField]: classId, [requestField]: clientRequestId })
          .limit(1)
          .get()
        const row = result.data && result.data.length ? result.data[0] : null
        if (row) {
          const key = String(row._id || row.id || '')
          if (!seen.has(key)) return row
          seen.add(key)
        }
      } catch (error) {
        if (!missingResource(error)) throw error
      }
    }
  }
  return null
}

async function transactionGet(transaction, collectionName, documentId) {
  try {
    const result = await transaction.collection(collectionName).doc(String(documentId)).get()
    return result && result.data ? result.data : null
  } catch (error) {
    if (missingResource(error)) return null
    throw error
  }
}

async function transactionQueryOne(transaction, collectionName, condition) {
  try {
    const result = await transaction.collection(collectionName).where(condition).limit(1).get()
    return result && Array.isArray(result.data) && result.data.length ? result.data[0] : null
  } catch (error) {
    if (missingResource(error)) return null
    throw error
  }
}

async function maxLogicalId(transaction, collectionName, classId) {
  let max = 0
  for (const field of ['class_id', 'classId']) {
    try {
      // CloudBase 单次 get 默认可能只返回 20 条；迁移班级名单后必须分页，
      // 否则计数器初始化可能撞上第 21 个及以后的逻辑 id。
      let offset = 0
      const pageSize = 100
      while (true) {
        const result = await transaction.collection(collectionName)
          .where({ [field]: classId })
          .skip(offset)
          .limit(pageSize)
          .get()
        const rows = result && Array.isArray(result.data) ? result.data : []
        rows.forEach(row => {
          const value = numericLogicalId(row && row.id)
          if (value !== null && value > max) max = value
        })
        if (rows.length < pageSize) break
        offset += rows.length
      }
    } catch (error) {
      if (!missingResource(error)) throw error
    }
  }
  return max
}

/**
 * 为需要展示的实体分配逻辑数字 id。计数器本身也在同一事务里读写，
 * 旧数据不存在计数器时先扫描已有 id，避免迁移后从 1 开始撞号。
 */
async function allocateLogicalId(transaction, collectionName, classId, namespace) {
  const counterId = hashId('counter', `${namespace}|${classId}`)
  const counter = await transactionGet(transaction, COLLECTIONS.counters, counterId)
  let nextId = counter && numericLogicalId(counter.next_id || counter.nextId)

  if (nextId === null) {
    nextId = (await maxLogicalId(transaction, collectionName, classId)) + 1
    await transaction.collection(COLLECTIONS.counters).doc(counterId).set({
      data: {
        id: counterId,
        class_id: classId,
        classId,
        namespace,
        next_id: nextId + 1,
        nextId: nextId + 1,
        updated_at: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
    return nextId
  }

  await transaction.collection(COLLECTIONS.counters).doc(counterId).update({
    data: {
      next_id: nextId + 1,
      nextId: nextId + 1,
      updated_at: db.serverDate(),
      updatedAt: db.serverDate()
    }
  })
  return nextId
}

function groupNameFrom(source = {}) {
  return cleanString(source.group || source.groupName || source.group_name, 40) || '未分组'
}

function groupIdFrom(source = {}, classId) {
  const explicit = cleanString(source.group_id || source.groupId, 80)
  return explicit || canonicalGroupId(classId, groupNameFrom(source))
}

function studentIdFrom(source = {}) {
  return source.id !== undefined && source.id !== null
    ? source.id
    : (source.student_id !== undefined && source.student_id !== null
      ? source.student_id
      : (source.studentId !== undefined && source.studentId !== null ? source.studentId : source._id))
}

function recordIdFrom(source = {}) {
  return source.recordId || source.eventId || source.scoreRecordId || source.id || source._id
}

function canonicalRecordValue(record, canonical, legacy, fallback = undefined) {
  if (record && record[canonical] !== undefined) return record[canonical]
  if (record && record[legacy] !== undefined) return record[legacy]
  return fallback
}

function recordStudentId(record) {
  return canonicalRecordValue(record, 'student_id', 'studentId', record && record.studentId)
}

function recordPoints(record) {
  return canonicalRecordValue(record, 'points', 'delta', 0)
}

function recordCreatedAt(record) {
  return canonicalRecordValue(record, 'created_at', 'occurredAt', record && record.createdAt)
}

function dateValue(value, fallback) {
  if (value && typeof value === 'object' && value.$date !== undefined) value = value.$date
  if (value && typeof value === 'object') {
    if (typeof value.toDate === 'function') {
      try { value = value.toDate() } catch (error) {}
    }
    if (typeof value.seconds === 'number') value = value.seconds * 1000
    else if (typeof value._seconds === 'number') value = value._seconds * 1000
  }
  if (value instanceof Date) return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 兼容历史导入：10 位 Unix 秒与 13 位毫秒都可直接使用。
    const timestamp = Math.abs(value) < 100000000000 ? value * 1000 : value
    const parsed = new Date(timestamp)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  if (value !== undefined && value !== null && String(value).trim()) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return fallback
}

async function addScore(event, context) {
  // 每个 action 的第一步都必须鉴权；classConfig 只用于解析当前学期。
  const classConfig = await assertAdmin(context.openid, context.classId)

  const requestedStudentId = event.student_id !== undefined
    ? event.student_id
    : (event.studentId !== undefined ? event.studentId : event.memberId)
  const delta = validDelta(event.points !== undefined ? event.points : event.delta)
  const category = cleanString(event.category, 30)
  const reason = cleanString(event.reason || event.note || '课堂记录', 80)
  const note = cleanString(event.note, 200)
  const requestId = cleanString(event.clientRequestId, 128)
  const termId = cleanString(
    event.term_id || event.termId || classConfig.current_term_id || classConfig.currentTermId,
    64
  )
  const ruleId = cleanString(event.ruleId || event.rule_id, 64)

  if (requestedStudentId === undefined || requestedStudentId === null || requestedStudentId === '' || delta === null || !category || !termId) {
    throw new ActionError('BAD_REQUEST', 'student_id、points、category、term_id 均为必填项；未传 term_id 时请先配置 classConfig.current_term_id')
  }
  if (!CATEGORY_SET.has(category)) {
    throw new ActionError('BAD_REQUEST', 'category 只能是 study、sports、labor、discipline 之一')
  }

  const student = await findClassDocument(COLLECTIONS.students, requestedStudentId, context.classId, { student: true })
  if (!student || student.active === false) {
    throw new ActionError('NOT_FOUND', '学生不存在或已停用')
  }
  const studentId = numericLogicalId(student.id)
  if (studentId === null) {
    throw new ActionError('DATA_MIGRATION_REQUIRED', '学生缺少数字逻辑 id，请先迁移学生数据后再记分')
  }

  const term = await findClassDocument(COLLECTIONS.terms, termId, context.classId)
  if (!term) {
    throw new ActionError('TERM_NOT_FOUND', `学期 ${termId} 不存在或不属于当前班级`)
  }
  if (term.active === false || term.status === 'archived') {
    throw new ActionError('TERM_INACTIVE', '该学期已停用，不能继续记分')
  }

  const duplicate = await findDuplicate(COLLECTIONS.records, context.classId, requestId)
  if (duplicate) {
    return { ok: true, action: 'add', duplicate: true, record: publicDocument(duplicate) }
  }

  const now = db.serverDate()
  const persistedRequestId = requestId || makeRequestId(context.openid)
  const createdAt = dateValue(event.created_at || event.occurredAt || event.createdAt, now)
  const groupId = groupIdFrom(student, context.classId)
  const record = {
    // 积分流水的业务 id 使用幂等请求号，CloudBase _id 仍作为底层文档定位；
    // 学生 id 才是数字自增主键。
    id: persistedRequestId,
    class_id: context.classId,
    student_id: studentId,
    group_id: groupId,
    points: delta,
    category,
    reason,
    note,
    operator_openid: context.openid,
    operator_name: cleanString(event.operatorName || event.operator_name || '管理员', 30),
    created_at: createdAt,
    term_id: termId,
    rule_id: ruleId || '',
    client_request_id: persistedRequestId,
    // voided/deleted 是审计状态，不是累计总分缓存。
    voided: false,
    deleted: false
  }

  const recordId = await withTransaction('写入积分失败，请稍后重试', async transaction => {
    const inserted = await transaction.collection(COLLECTIONS.records).add({ data: record })
    await transaction.collection(COLLECTIONS.audit).add({
      data: auditEntry('score.add', context.classId, context.openid, {
        student_id: studentId,
        points: delta,
        record_id: inserted._id,
        client_request_id: record.client_request_id
      })
    })
    return inserted._id
  })

  const saved = await getDocument(COLLECTIONS.records, recordId)
  return { ok: true, action: 'add', record: publicDocument(saved || { ...record, _id: recordId }) }
}

async function voidScore(event, context) {
  await assertAdmin(context.openid, context.classId)

  const eventId = cleanString(recordIdFrom(event), 128)
  if (!eventId) throw new ActionError('BAD_REQUEST', '缺少 eventId')

  const target = await findClassDocument(COLLECTIONS.records, eventId, context.classId)
  if (!target) throw new ActionError('NOT_FOUND', '记录不存在')
  const targetId = target._id || target.id
  if (target.voided || target.deleted) return { ok: true, action: 'void', eventId: targetId, duplicate: true }

  await withTransaction('撤销失败，请稍后重试', async transaction => {
    const now = db.serverDate()
    await transaction.collection(COLLECTIONS.records).doc(String(targetId)).update({
      data: {
        voided: true,
        voided_at: now,
        voided_by: context.openid,
        updated_at: now,
        last_mutation_request_id: cleanString(event.clientRequestId, 128)
      }
    })
    await transaction.collection(COLLECTIONS.audit).add({
      data: auditEntry('score.void', context.classId, context.openid, {
        student_id: recordStudentId(target),
        studentId: recordStudentId(target),
        points: recordPoints(target),
        delta: recordPoints(target),
        record_id: targetId,
        recordId: targetId,
        clientRequestId: cleanString(event.clientRequestId, 128)
      })
    })
  })

  return { ok: true, action: 'void', eventId: targetId }
}

function scorePatch(event) {
  const source = isPlainObject(event.patch) ? event.patch : event
  const patch = {}

  if (source.points !== undefined || source.delta !== undefined) {
    const points = validDelta(source.points !== undefined ? source.points : source.delta)
    if (points === null) throw new ActionError('BAD_REQUEST', 'points 必须为 -20 至 20 之间的非零整数')
    patch.points = points
  }

  if (source.category !== undefined) {
    const category = cleanString(source.category, 30)
    if (!CATEGORY_SET.has(category)) {
      throw new ActionError('BAD_REQUEST', 'category 只能是 study、sports、labor、discipline 之一')
    }
    patch.category = category
  }

  if (source.note !== undefined) patch.note = cleanString(source.note, 200)
  if (source.reason !== undefined) patch.reason = cleanString(source.reason, 80)

  if (source.created_at !== undefined || source.occurredAt !== undefined || source.createdAt !== undefined) {
    const rawDate = source.created_at !== undefined
      ? source.created_at
      : (source.occurredAt !== undefined ? source.occurredAt : source.createdAt)
    const createdAt = dateValue(rawDate, null)
    if (!createdAt) throw new ActionError('BAD_REQUEST', 'created_at 不是有效日期')
    patch.created_at = createdAt
  }

  if (source.term_id !== undefined || source.termId !== undefined) {
    const termId = cleanString(source.term_id !== undefined ? source.term_id : source.termId, 64)
    if (!termId) throw new ActionError('BAD_REQUEST', 'term_id 不能为空')
    patch.term_id = termId
  }

  if (!Object.keys(patch).length) throw new ActionError('BAD_REQUEST', '没有可修改的积分字段')
  return patch
}

/** 安全修改：学生归属和记录 id 不允许通过此 action 改写。 */
async function updateScore(event, context) {
  await assertAdmin(context.openid, context.classId)

  const requestedId = cleanString(recordIdFrom(event), 128)
  if (!requestedId) throw new ActionError('BAD_REQUEST', '缺少 recordId')
  const target = await findClassDocument(COLLECTIONS.records, requestedId, context.classId)
  if (!target) throw new ActionError('NOT_FOUND', '记录不存在')
  if (target.deleted) throw new ActionError('RECORD_DELETED', '已删除的积分记录不能修改')
  if (target.voided) throw new ActionError('RECORD_VOIDED', '已撤销的积分记录不能修改')

  const requestId = cleanString(event.clientRequestId, 128)
  const targetId = target._id || target.id
  if (requestId && (target.last_mutation_request_id === requestId || target.lastMutationRequestId === requestId)) {
    return { ok: true, action: 'update', duplicate: true, record: publicDocument(target) }
  }

  const patch = scorePatch(event)
  const effectiveStudentId = numericLogicalId(recordStudentId(target))
  const effectiveTermId = cleanString(
    patch.term_id || canonicalRecordValue(target, 'term_id', 'termId', ''),
    64
  )
  const effectivePoints = validDelta(patch.points !== undefined ? patch.points : recordPoints(target))
  const effectiveCategory = cleanString(patch.category || target.category, 30)
  const effectiveCreatedAt = patch.created_at || dateValue(recordCreatedAt(target), null)
  if (effectiveStudentId === null || effectivePoints === null || !effectiveTermId || !effectiveCreatedAt) {
    throw new ActionError('DATA_MIGRATION_REQUIRED', '旧积分记录缺少有效 student_id、points、term_id 或 created_at，请先迁移后再修改')
  }
  if (!CATEGORY_SET.has(effectiveCategory)) {
    throw new ActionError('DATA_MIGRATION_REQUIRED', '旧积分记录的 category 不属于四个固定维度，请先迁移后再修改')
  }

  const term = await findClassDocument(COLLECTIONS.terms, effectiveTermId, context.classId)
  if (!term) throw new ActionError('TERM_NOT_FOUND', `学期 ${effectiveTermId} 不存在或不属于当前班级`)
  if (term.active === false || term.status === 'archived') {
    throw new ActionError('TERM_INACTIVE', '该学期已停用，不能把积分记录移入该学期')
  }

  // 修改旧记录时顺手补齐规范字段；兼容字段只读，不再继续写入。
  Object.assign(patch, {
    class_id: context.classId,
    student_id: effectiveStudentId,
    points: effectivePoints,
    category: effectiveCategory,
    created_at: effectiveCreatedAt,
    term_id: effectiveTermId,
    note: patch.note !== undefined ? patch.note : cleanString(target.note, 200)
  })
  const now = db.serverDate()
  await withTransaction('修改积分失败，请稍后重试', async transaction => {
    await transaction.collection(COLLECTIONS.records).doc(String(targetId)).update({
      data: {
        ...patch,
        updated_at: now,
        updated_by: context.openid,
        last_mutation_request_id: requestId || makeRequestId(context.openid)
      }
    })
    await transaction.collection(COLLECTIONS.audit).add({
      data: auditEntry('score.update', context.classId, context.openid, {
        record_id: targetId,
        recordId: targetId,
        student_id: effectiveStudentId,
        studentId: effectiveStudentId,
        fields: Object.keys(patch),
        before: {
          points: recordPoints(target),
          category: target.category,
          note: target.note || '',
          created_at: recordCreatedAt(target),
          term_id: canonicalRecordValue(target, 'term_id', 'termId', '')
        },
        clientRequestId: requestId
      })
    })
  })

  const saved = await getDocument(COLLECTIONS.records, targetId)
  return { ok: true, action: 'update', record: publicDocument(saved || { ...target, ...patch }) }
}

/**
 * 安全删除采用软删除并保留审计信息；同时标记 voided，让尚未升级的客户端
 * 也会立刻排除这条记录。原始记录不物理删除，便于追责和恢复。
 */
async function deleteScore(event, context) {
  await assertAdmin(context.openid, context.classId)

  const requestedId = cleanString(recordIdFrom(event), 128)
  if (!requestedId) throw new ActionError('BAD_REQUEST', '缺少 recordId')
  const target = await findClassDocument(COLLECTIONS.records, requestedId, context.classId)
  if (!target) throw new ActionError('NOT_FOUND', '记录不存在')
  const targetId = target._id || target.id
  if (target.deleted) return { ok: true, action: 'delete', duplicate: true, recordId: targetId }

  const requestId = cleanString(event.clientRequestId, 128)
  const deleteReason = cleanString(event.delete_reason || event.deleteReason || event.reason, 200)
  const now = db.serverDate()
  await withTransaction('删除积分失败，请稍后重试', async transaction => {
    await transaction.collection(COLLECTIONS.records).doc(String(targetId)).update({
      data: {
        deleted: true,
        deleted_at: now,
        deleted_by: context.openid,
        delete_reason: deleteReason,
        voided: true,
        voided_at: target.voided_at || target.voidedAt || now,
        voided_by: target.voided_by || target.voidedBy || context.openid,
        updated_at: now,
        last_mutation_request_id: requestId || makeRequestId(context.openid)
      }
    })
    await transaction.collection(COLLECTIONS.audit).add({
      data: auditEntry('score.delete', context.classId, context.openid, {
        record_id: targetId,
        recordId: targetId,
        student_id: recordStudentId(target),
        studentId: recordStudentId(target),
        points: recordPoints(target),
        delta: recordPoints(target),
        delete_reason: deleteReason,
        clientRequestId: requestId
      })
    })
  })

  return { ok: true, action: 'delete', recordId: targetId }
}

function sanitizeConfigPatch(event) {
  const source = requirePlainObject(event.config || event.patch || {}, 'config')
  const configPatch = {}
  let settingsPatch = null

  Object.keys(source).forEach(key => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      throw new ActionError('BAD_REQUEST', `配置字段 ${key} 不合法`)
    }
    if (RESERVED_CONFIG_KEYS.has(key)) {
      throw new ActionError('FORBIDDEN_FIELD', `配置字段 ${key} 只能在云开发控制台维护`)
    }
    if (key === 'settings') {
      settingsPatch = requirePlainObject(source[key], 'settings')
      return
    }
    if (key === 'badges') {
      settingsPatch = { ...(settingsPatch || {}), badges: source[key] }
      return
    }
    if (source[key] !== undefined) configPatch[key] = source[key]
  })

  if (event.settings !== undefined) {
    settingsPatch = requirePlainObject(event.settings, 'settings')
  }

  if (!Object.keys(configPatch).length && !settingsPatch) {
    throw new ActionError('BAD_REQUEST', '没有需要更新的配置')
  }

  let encoded
  try {
    encoded = JSON.stringify({ configPatch, settingsPatch })
  } catch (error) {
    throw new ActionError('BAD_REQUEST', '配置内容无法序列化')
  }
  if (encoded.length > 200000) throw new ActionError('BAD_REQUEST', '配置内容过大')

  return JSON.parse(encoded)
}

async function updateConfig(event, context) {
  await assertAdmin(context.openid, context.classId)

  const { configPatch, settingsPatch } = sanitizeConfigPatch(event)
  await withTransaction('保存班级配置失败，请稍后重试', async transaction => {
    const now = db.serverDate()
    if (Object.keys(configPatch).length) {
      await transaction.collection(COLLECTIONS.config).doc(context.classId).update({
        data: { ...configPatch, updated_at: now, updatedAt: now }
      })
    }

    if (settingsPatch) {
      let existingSettings = await transactionGet(transaction, COLLECTIONS.settings, context.classId)
      if (!existingSettings) {
        for (const field of ['class_id', 'classId', 'id']) {
          existingSettings = await transactionQueryOne(transaction, COLLECTIONS.settings, { [field]: context.classId })
          if (existingSettings) break
        }
      }
      const preservedSettings = existingSettings ? { ...existingSettings } : {}
      delete preservedSettings._id
      delete preservedSettings._openid
      const settingsData = {
        ...preservedSettings,
        ...settingsPatch,
        id: context.classId,
        class_id: context.classId,
        classId: context.classId,
        updated_at: now,
        updatedAt: now
      }
      if (existingSettings) {
        // 兼容早期 settings 集合使用自动 _id 的文档；不要假设它一定等于 classId。
        const settingsDocumentId = existingSettings._id || context.classId
        await transaction.collection(COLLECTIONS.settings).doc(String(settingsDocumentId)).update({ data: settingsData })
      } else {
        await transaction.collection(COLLECTIONS.settings).doc(context.classId).set({ data: settingsData })
      }
    }

    await transaction.collection(COLLECTIONS.audit).add({
      data: auditEntry('config.update', context.classId, context.openid, {
        fields: Object.keys(configPatch),
        settingsFields: settingsPatch ? Object.keys(settingsPatch) : [],
        clientRequestId: cleanString(event.clientRequestId, 128)
      })
    })
  })

  const config = await getDocument(COLLECTIONS.config, context.classId)
  return { ok: true, action: 'updateConfig', config: publicDocument(config) }
}

function memberInput(event) {
  return isPlainObject(event.member) ? event.member : event
}

async function addMember(event, context) {
  await assertAdmin(context.openid, context.classId)

  const source = memberInput(event)
  const name = cleanString(source.name, 30)
  const requestId = cleanString(event.clientRequestId || source.clientRequestId, 128)
  if (!name) throw new ActionError('BAD_REQUEST', '请输入学生姓名')

  const duplicate = await findDuplicate(COLLECTIONS.students, context.classId, requestId)
  if (duplicate) {
    return { ok: true, action: 'addMember', duplicate: true, member: publicDocument(duplicate) }
  }

  const requestedSortOrder = Number(source.sortOrder)
  const group = groupNameFrom(source)
  const groupId = groupIdFrom(source, context.classId)
  const persistedRequestId = requestId || makeRequestId(context.openid)

  const result = await withTransaction('新增学生失败，请稍后重试', async transaction => {
    const logicalId = await allocateLogicalId(transaction, COLLECTIONS.students, context.classId, 'students')
    const sortOrder = Number.isInteger(requestedSortOrder)
      ? requestedSortOrder
      : logicalId - 1
    const now = db.serverDate()
    // canonical 字段是统计与业务数据源；旧字段只在读取适配层转换。
    const member = {
      id: logicalId,
      class_id: context.classId,
      name,
      group_id: groupId,
      active: source.active === undefined ? true : Boolean(source.active),
      sort_order: sortOrder,
      joined_at: now,
      created_at: now,
      updated_at: now,
      client_request_id: persistedRequestId,
      student_no: cleanString(source.studentNo || source.student_no, 30),
      color: cleanString(source.color || source.avatarColor || '#5B8DEF', 30)
    }

    const inserted = await transaction.collection(COLLECTIONS.students).add({ data: member })

    // 小组文档以稳定 hash 作为 _id，避免同一班级重名组重复创建。
    const groupDocId = hashId('grpdoc', `${context.classId}|${groupId}`)
    const existingGroup = await transactionGet(transaction, COLLECTIONS.groups, groupDocId)
    const groupLabel = group === '未分组' && existingGroup
      ? cleanString(existingGroup.name || existingGroup.label || group, 40)
      : group
    const groupData = {
      id: groupId,
      class_id: context.classId,
      classId: context.classId,
      name: groupLabel,
      label: groupLabel,
      active: true,
      updated_at: now,
      updatedAt: now
    }
    if (existingGroup) {
      await transaction.collection(COLLECTIONS.groups).doc(groupDocId).update({ data: groupData })
    } else {
      await transaction.collection(COLLECTIONS.groups).doc(groupDocId).set({ data: groupData })
    }

    await transaction.collection(COLLECTIONS.audit).add({
      data: auditEntry('student.add', context.classId, context.openid, {
        student_id: logicalId,
        studentId: logicalId,
        group_id: groupId,
        record_id: inserted._id,
        client_request_id: persistedRequestId
      })
    })
    return { member, cloudId: inserted._id }
  })

  const saved = await getDocument(COLLECTIONS.students, result.cloudId)
  return { ok: true, action: 'addMember', member: publicDocument(saved || { ...result.member, _id: result.cloudId }) }
}

async function toggleMember(event, context) {
  await assertAdmin(context.openid, context.classId)

  const requestedMemberId = event.member_id !== undefined
    ? event.member_id
    : (event.memberId !== undefined ? event.memberId : event.studentId)
  const memberId = cleanString(requestedMemberId, 128)
  if (!memberId || typeof event.active !== 'boolean') {
    throw new ActionError('BAD_REQUEST', 'memberId 和布尔值 active 均为必填项')
  }

  const member = await findClassDocument(COLLECTIONS.students, requestedMemberId, context.classId, { student: true })
  if (!member) throw new ActionError('NOT_FOUND', '学生不存在')
  if (member.active === event.active) {
    return { ok: true, action: 'toggleMember', duplicate: true, memberId, active: event.active }
  }

  const cloudMemberId = member._id || member.id

  await withTransaction('更新学生状态失败，请稍后重试', async transaction => {
    const now = db.serverDate()
    await transaction.collection(COLLECTIONS.students).doc(String(cloudMemberId)).update({
      data: { active: event.active, updated_at: now, updatedAt: now }
    })
    await transaction.collection(COLLECTIONS.audit).add({
      data: auditEntry('student.toggle', context.classId, context.openid, {
        student_id: member.id !== undefined ? member.id : cloudMemberId,
        studentId: member.id !== undefined ? member.id : cloudMemberId,
        active: event.active,
        client_request_id: cleanString(event.clientRequestId, 128)
      })
    })
  })

  return { ok: true, action: 'toggleMember', memberId: member.id !== undefined ? member.id : cloudMemberId, active: event.active }
}

function ruleInput(event) {
  return isPlainObject(event.rule) ? event.rule : event
}

function makeRule(source, classId, openid, requestId) {
  const label = cleanString(source.label, 30)
  const category = cleanString(source.category || source.category_code, 30)
  const defaultDelta = source.defaultDelta === undefined ? 1 : validDelta(source.defaultDelta)
  if (!label) throw new ActionError('BAD_REQUEST', '请输入规则名称')
  if (defaultDelta === null) throw new ActionError('BAD_REQUEST', '默认分值必须为 -20 至 20 之间的非零整数')
  if (category && !CATEGORY_SET.has(category)) {
    throw new ActionError('BAD_REQUEST', 'category 只能是 study、sports、labor、discipline 之一')
  }

  const now = db.serverDate()
  const persistedRequestId = requestId || makeRequestId(openid)
  const rule = {
    class_id: classId,
    classId,
    label,
    icon: cleanString(source.icon || '✦', 8),
    defaultDelta,
    allowNegative: source.allowNegative === undefined ? true : Boolean(source.allowNegative),
    enabled: source.enabled === undefined ? true : Boolean(source.enabled),
    created_at: now,
    createdAt: now,
    updated_at: now,
    updatedAt: now,
    client_request_id: persistedRequestId,
    clientRequestId: persistedRequestId
  }
  if (category) rule.category = category
  return rule
}

async function addRule(event, context) {
  await assertAdmin(context.openid, context.classId)

  const source = ruleInput(event)
  const requestId = cleanString(event.clientRequestId || source.clientRequestId, 128)
  const duplicate = await findDuplicate(COLLECTIONS.rules, context.classId, requestId)
  if (duplicate) {
    return { ok: true, action: 'addRule', duplicate: true, rule: publicDocument(duplicate) }
  }

  const rule = makeRule(source, context.classId, context.openid, requestId)
  const ruleId = await withTransaction('新增评分规则失败，请稍后重试', async transaction => {
    const inserted = await transaction.collection(COLLECTIONS.rules).add({ data: rule })
    await transaction.collection(COLLECTIONS.audit).add({
      data: auditEntry('rule.add', context.classId, context.openid, {
        ruleId: inserted._id,
        clientRequestId: rule.clientRequestId
      })
    })
    return inserted._id
  })

  const saved = await getDocument(COLLECTIONS.rules, ruleId)
  return { ok: true, action: 'addRule', rule: publicDocument(saved || { ...rule, _id: ruleId }) }
}

function sanitizeRulePatch(event) {
  const source = requirePlainObject(event.patch || event.rule, 'patch')
  const patch = {}

  if (source.label !== undefined) {
    patch.label = cleanString(source.label, 30)
    if (!patch.label) throw new ActionError('BAD_REQUEST', '规则名称不能为空')
  }
  if (source.icon !== undefined) {
    patch.icon = cleanString(source.icon, 8)
    if (!patch.icon) throw new ActionError('BAD_REQUEST', '规则图标不能为空')
  }
  if (source.category !== undefined || source.category_code !== undefined) {
    const category = cleanString(source.category || source.category_code, 30)
    if (!CATEGORY_SET.has(category)) {
      throw new ActionError('BAD_REQUEST', 'category 只能是 study、sports、labor、discipline 之一')
    }
    patch.category = category
  }
  if (source.defaultDelta !== undefined) {
    patch.defaultDelta = validDelta(source.defaultDelta)
    if (patch.defaultDelta === null) {
      throw new ActionError('BAD_REQUEST', '默认分值必须为 -20 至 20 之间的非零整数')
    }
  }
  if (source.allowNegative !== undefined) patch.allowNegative = Boolean(source.allowNegative)
  if (source.enabled !== undefined) patch.enabled = Boolean(source.enabled)

  if (!Object.keys(patch).length) throw new ActionError('BAD_REQUEST', '没有需要更新的规则字段')
  return patch
}

async function updateRule(event, context) {
  await assertAdmin(context.openid, context.classId)

  const ruleId = cleanString(event.ruleId, 64)
  if (!ruleId) throw new ActionError('BAD_REQUEST', '缺少 ruleId')

  const target = await findClassDocument(COLLECTIONS.rules, ruleId, context.classId)
  if (!target) throw new ActionError('NOT_FOUND', '评分规则不存在')
  const cloudRuleId = target._id || target.id

  const patch = sanitizeRulePatch(event)
  await withTransaction('更新评分规则失败，请稍后重试', async transaction => {
    await transaction.collection(COLLECTIONS.rules).doc(String(cloudRuleId)).update({
      data: { ...patch, updated_at: db.serverDate(), updatedAt: db.serverDate() }
    })
    await transaction.collection(COLLECTIONS.audit).add({
      data: auditEntry('rule.update', context.classId, context.openid, {
        ruleId: target.id !== undefined ? target.id : cloudRuleId,
        fields: Object.keys(patch),
        clientRequestId: cleanString(event.clientRequestId, 128)
      })
    })
  })

  const saved = await getDocument(COLLECTIONS.rules, cloudRuleId)
  return { ok: true, action: 'updateRule', rule: publicDocument(saved) }
}

const ACTION_HANDLERS = Object.freeze({
  add: addScore,
  void: voidScore,
  update: updateScore,
  updateScore,
  delete: deleteScore,
  deleteScore,
  remove: deleteScore,
  updateConfig,
  addMember,
  toggleMember,
  addRule,
  updateRule
})

exports.main = async (event = {}) => {
  const action = cleanString(event.action || 'add', 40)
  const handler = ACTION_HANDLERS[action]
  if (!handler) return fail(`不支持的 action：${action}`, 'UNKNOWN_ACTION')

  const wxContext = cloud.getWXContext()
  const context = {
    openid: cleanString(wxContext.OPENID, 128),
    classId: cleanString(event.class_id || event.classId, 128)
  }

  try {
    return await handler(event, context)
  } catch (error) {
    if (error instanceof ActionError) return fail(error.message, error.code)
    console.error(`score action ${action} failed`, error)
    return fail('云端操作失败，请稍后重试', 'INTERNAL_ERROR')
  }
}
