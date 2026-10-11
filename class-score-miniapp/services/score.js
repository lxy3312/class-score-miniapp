// 统一积分统计层。
//
// 这里的所有分数都由原始 scoreRecords 在每次调用时重新聚合，绝不写回或
// 缓存总分。页面只需要消费本文件返回的结果，不应在组件中再次计算。
//
// 排名规则：竞争排名（1, 2, 2, 4）。先按分数降序，再按姓名升序；姓名
// 相同则按原始名单顺序/ID 保持稳定。四个 category 是唯一统计维度。

const defaultStore = require('./store.js')

const CATEGORIES = Object.freeze(['study', 'sports', 'labor', 'discipline'])
const CATEGORY_LABELS = Object.freeze({
  study: '学习',
  sports: '体育',
  labor: '劳动',
  discipline: '纪律'
})

function hasOwn(object, key) {
  return object != null && Object.prototype.hasOwnProperty.call(object, key)
}

function pick(object, keys, fallback) {
  if (!object || typeof object !== 'object') return fallback
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (hasOwn(object, key) && object[key] !== undefined && object[key] !== null && object[key] !== '') {
      return object[key]
    }
  }
  return fallback
}

function clone(value) {
  if (value === undefined) return value
  try { return JSON.parse(JSON.stringify(value)) } catch (error) { return value }
}

function idKey(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

function finiteNumber(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

function parseDate(value) {
  if (value === undefined || value === null || value === '') return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime())
  }
  if (typeof value === 'number') {
    // CloudBase/导入脚本有时会给 Unix 秒，有时给毫秒；按数量级兼容两者。
    const timestamp = Math.abs(value) < 100000000000 ? value * 1000 : value
    const date = new Date(timestamp)
    return Number.isNaN(date.getTime()) ? null : date
  }
  if (typeof value === 'object') {
    if (typeof value.toDate === 'function') {
      try { return parseDate(value.toDate()) } catch (error) { return null }
    }
    if (value.$date !== undefined) return parseDate(value.$date)
    if (value.seconds !== undefined) return parseDate(Number(value.seconds) * 1000)
    if (value._seconds !== undefined) return parseDate(Number(value._seconds) * 1000)
    if (value.timestamp !== undefined) return parseDate(value.timestamp)
  }
  const text = String(value).trim()
  if (!text) return null
  // ECMAScript 对 YYYY-MM-DD 的解析在不同运行时可能按 UTC 处理；这里
  // 显式按设备本地时区构造，保证周边界符合“本地时区”的约定。
  const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (dateOnly) {
    const date = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    return Number.isNaN(date.getTime()) ? null : date
  }
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date
}

function startOfLocalDay(value) {
  const date = parseDate(value) || new Date()
  date.setHours(0, 0, 0, 0)
  return date
}

function endOfLocalDay(value) {
  const date = startOfLocalDay(value)
  date.setHours(23, 59, 59, 999)
  return date
}

function localDateKey(value) {
  const date = parseDate(value)
  if (!date) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function localDateLabel(value) {
  const date = parseDate(value)
  if (!date) return ''
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

function mondayRange(value) {
  const start = startOfLocalDay(value)
  // getDay(): Sunday=0; Monday=1. This produces Monday 00:00 for every input.
  const offset = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - offset)
  const endExclusive = new Date(start.getTime())
  endExclusive.setDate(endExclusive.getDate() + 7)
  const endInclusive = new Date(endExclusive.getTime() - 1)
  return { start, endExclusive, endInclusive }
}

function dateRangeFromTerm(term) {
  if (!term || typeof term !== 'object') return null
  const startValue = pick(term, ['start_date', 'startDate', 'termStart', 'term_start', 'start', 'beginDate', 'begin_at'], null)
  const endValue = pick(term, ['end_date', 'endDate', 'termEnd', 'term_end', 'end', 'finishDate', 'end_at'], null)
  const start = startValue ? startOfLocalDay(startValue) : null
  const end = endValue ? endOfLocalDay(endValue) : null
  if (!start && !end) return null
  return {
    start: start || new Date(-8640000000000000),
    endExclusive: end ? new Date(end.getTime() + 1) : new Date(8640000000000000),
    endInclusive: end || new Date(8640000000000000),
    startDate: start,
    endDate: end
  }
}

function spanRange(records) {
  const dates = (records || []).map(record => record && record._created).filter(date => date instanceof Date && !Number.isNaN(date.getTime()))
  if (!dates.length) {
    const start = startOfLocalDay(new Date())
    const endInclusive = endOfLocalDay(start)
    return { start, endInclusive, endExclusive: new Date(endInclusive.getTime() + 1) }
  }
  const first = dates.reduce((left, right) => left.getTime() <= right.getTime() ? left : right)
  const last = dates.reduce((left, right) => left.getTime() >= right.getTime() ? left : right)
  const start = startOfLocalDay(first)
  const endInclusive = endOfLocalDay(last)
  return { start, endInclusive, endExclusive: new Date(endInclusive.getTime() + 1) }
}

function canonicalCategory(value) {
  const key = String(value === undefined || value === null ? '' : value).trim()
  return CATEGORIES.indexOf(key) >= 0 ? key : ''
}

function zeroCategories() {
  return { study: 0, sports: 0, labor: 0, discipline: 0 }
}

function categoryCopy(value) {
  const result = zeroCategories()
  if (!value || typeof value !== 'object') return result
  CATEGORIES.forEach(category => { result[category] = finiteNumber(value[category], 0) })
  return result
}

function sumCategories(categories) {
  return CATEGORIES.reduce((sum, category) => sum + finiteNumber(categories[category], 0), 0)
}

function normalizeGroup(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  // 与学生一样，优先采用业务 group_id；自动生成的 CloudBase _id 仅作回退。
  const id = pick(raw, ['id', 'group_id', 'groupId', '_id'], index + 1)
  return {
    id,
    group_id: id,
    groupId: id,
    name: String(pick(raw, ['name', 'group_name', 'groupName', 'label'], '未分组') || '未分组'),
    active: raw.active !== false && raw.enabled !== false && raw.status !== 'archived',
    sortOrder: Number.isFinite(Number(raw.sort_order !== undefined ? raw.sort_order : raw.sortOrder))
      ? Number(raw.sort_order !== undefined ? raw.sort_order : raw.sortOrder)
      : index,
    _order: index
  }
}

function normalizeMember(raw, index, groupMap) {
  if (!raw || typeof raw !== 'object') return null
  const rawGroup = pick(raw, ['group', 'groupName', 'group_name'], '')
  let groupId = pick(raw, ['group_id', 'groupId', 'groupID'], null)
  let groupName = pick(raw, ['group_name', 'groupName'], null)
  if (rawGroup && typeof rawGroup === 'object') {
    groupId = groupId == null ? pick(rawGroup, ['id', '_id', 'group_id', 'groupId'], null) : groupId
    groupName = groupName || pick(rawGroup, ['name', 'label', 'groupName'], '')
  } else if (!groupName) {
    groupName = rawGroup
  }
  if (!groupName && groupId !== null && groupId !== undefined && groupMap && groupMap[idKey(groupId)]) {
    groupName = groupMap[idKey(groupId)].name
  }
  groupName = String(groupName || '未分组').trim() || '未分组'
  if (groupId === null || groupId === undefined || groupId === '') groupId = groupName
  // 业务主键优先使用数字 id/student_id；CloudBase 的 _id 只作为旧数据回退，
  // 否则“_id + student_id”并存的文档会和积分流水错配。
  const id = pick(raw, ['id', 'student_id', 'studentId', '_id'], index + 1)
  const name = String(pick(raw, ['name', 'studentName', 'student_name'], '') || '').trim()
  return {
    id,
    student_id: id,
    name,
    groupId,
    group_id: groupId,
    group: groupName,
    groupName,
    active: raw.active !== false && raw.enabled !== false,
    sortOrder: Number.isFinite(Number(raw.sortOrder)) ? Number(raw.sortOrder) : index,
    joinedAt: pick(raw, ['joined_at', 'joinedAt', 'created_at', 'createdAt'], null),
    color: raw.color || raw.avatarColor || '',
    studentNo: raw.studentNo || raw.student_no || '',
    _order: index
  }
}

function normalizeRecord(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const category = canonicalCategory(pick(raw, ['category', 'dimension'], ''))
  const studentId = pick(raw, ['student_id', 'studentId', 'memberId', 'member_id'], null)
  const pointsValue = pick(raw, ['points', 'delta', 'score'], null)
  const points = finiteNumber(pointsValue, NaN)
  const createdValue = pick(raw, ['created_at', 'createdAt', 'occurredAt', 'occurred_at'], null)
  const created = parseDate(createdValue)
  if (studentId === null || studentId === undefined || studentId === '' || !Number.isFinite(points) || !created) return null
  const voided = raw.voided === true || raw.isVoided === true || raw.deleted === true || raw.isDeleted === true
    || Boolean(pick(raw, ['voided_at', 'voidedAt', 'deleted_at', 'deletedAt'], null))
  const id = pick(raw, ['id', '_id'], `record_${index + 1}`)
  const termId = pick(raw, ['term_id', 'termId', 'termID'], null)
  return {
    id,
    studentId,
    student_id: studentId,
    category,
    points,
    // delta 是旧版字段名；保留只为让旧页面/导出代码可读，统计始终使用 points。
    delta: points,
    createdAt: created.toISOString(),
    created_at: created.toISOString(),
    termId,
    term_id: termId,
    note: String(pick(raw, ['note', 'reason'], '') || ''),
    voided,
    _created: created,
    _order: index
  }
}

function sortName(a, b) {
  const left = String(a && (a.name || a.groupName || a.group || '') || '')
  const right = String(b && (b.name || b.groupName || b.group || '') || '')
  if (left !== right) {
    try {
      const compared = left.localeCompare(right, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
      if (compared !== 0) return compared
    } catch (error) {
      if (left < right) return -1
      if (left > right) return 1
    }
  }
  const leftOrder = Number.isFinite(Number(a && a._order)) ? Number(a._order) : 0
  const rightOrder = Number.isFinite(Number(b && b._order)) ? Number(b._order) : 0
  if (leftOrder !== rightOrder) return leftOrder - rightOrder
  const leftId = idKey(a && a.id)
  const rightId = idKey(b && b.id)
  return leftId < rightId ? -1 : (leftId > rightId ? 1 : 0)
}

function scoreFor(item, category) {
  if (category === 'total' || !category) return finiteNumber(item && item.total, 0)
  return finiteNumber(item && item.categories && item.categories[category], 0)
}

function rankItems(items, category) {
  const sorted = (items || []).slice().sort((left, right) => {
    const scoreDiff = scoreFor(right, category) - scoreFor(left, category)
    return scoreDiff || sortName(left, right)
  })
  let previousScore = null
  let previousRank = 0
  return sorted.map((item, index) => {
    const score = scoreFor(item, category)
    const rank = index === 0 || score !== previousScore ? index + 1 : previousRank
    previousScore = score
    previousRank = rank
    return {
      ...item,
      // score 是当前榜单维度的展示值；total 始终保留四维度之和。
      score,
      selectedScore: score,
      dimension: category || 'total',
      rank,
      rankLabel: String(rank)
    }
  })
}

function collectBadges(config) {
  const settings = config && config.settings && typeof config.settings === 'object' ? config.settings : null
  const nested = settings && settings.badges
  // 兼容两种云端设置文档：推荐 settings.badges，旧版也可能直接把
  // enabled/rules 放在 settings 根上。
  const source = nested && typeof nested === 'object'
    ? nested
    : (settings && Array.isArray(settings.rules) ? settings : (config && config.badges))
  if (!source || typeof source !== 'object' || source.enabled !== true || !Array.isArray(source.rules)) {
    return { enabled: false, rules: [] }
  }
  const rules = source.rules.map((rule, index) => {
    if (!rule || typeof rule !== 'object') return null
    const rank = Number(rule.rank)
    if (!Number.isFinite(rank) || rank < 1) return null
    const result = { rank }
    if (rule.icon !== undefined) result.icon = String(rule.icon)
    if (rule.label !== undefined) result.label = String(rule.label)
    if (rule.id !== undefined) result.id = rule.id
    result._order = index
    return result
  }).filter(Boolean).sort((a, b) => a.rank - b.rank || a._order - b._order)
  return { enabled: true, rules: rules.map(rule => {
    const result = { ...rule }
    delete result._order
    return result
  }) }
}

function badgeFor(rank, badgeConfig) {
  if (!badgeConfig || badgeConfig.enabled !== true) return null
  const rule = badgeConfig.rules.find(item => Number(item.rank) === Number(rank))
  return rule ? clone(rule) : null
}

function extractArray(provider, snapshot, methodNames, propertyNames) {
  const methods = methodNames || []
  for (let index = 0; index < methods.length; index += 1) {
    const method = methods[index]
    if (provider && typeof provider[method] === 'function') {
      try {
        const value = provider[method](true)
        if (Array.isArray(value)) return value
      } catch (error) {}
    }
  }
  const properties = propertyNames || []
  for (let index = 0; index < properties.length; index += 1) {
    const property = properties[index]
    if (provider && Array.isArray(provider[property])) return provider[property]
    if (snapshot && Array.isArray(snapshot[property])) return snapshot[property]
  }
  return []
}

function readSource(provider) {
  const source = provider || defaultStore
  let snapshot = null
  if (source && typeof source.getSnapshot === 'function') {
    try { snapshot = source.getSnapshot() } catch (error) { snapshot = null }
  }
  let config = null
  if (source && typeof source.getConfig === 'function') {
    try { config = source.getConfig() } catch (error) { config = null }
  }
  config = config || (snapshot && snapshot.config) || source.config || {}
  let groups = extractArray(source, snapshot, ['getGroups'], ['groups'])
  let members = extractArray(source, snapshot, ['getMembers'], ['members', 'students'])
  let events = extractArray(source, snapshot, ['getEvents'], ['events', 'scoreRecords', 'records'])
  let terms = extractArray(source, snapshot, ['getTerms'], ['terms'])
  if (!terms.length && Array.isArray(config.terms)) terms = config.terms
  const normalizedGroups = groups.map(normalizeGroup).filter(Boolean).filter(group => group.active)
  const groupMap = {}
  normalizedGroups.forEach(group => { groupMap[idKey(group.id)] = group })
  const normalizedMembers = members.map((member, index) => normalizeMember(member, index, groupMap)).filter(Boolean).filter(member => member.active)
  const normalizedEvents = events.map(normalizeRecord).filter(Boolean)
  return { config: config || {}, groups: normalizedGroups, members: normalizedMembers, events: normalizedEvents, terms }
}

function resolveTerm(config, terms, requestedId) {
  const sourceConfig = config || {}
  const configuredId = pick(sourceConfig, ['current_term_id', 'currentTermId', 'term_id', 'termId'], null)
  const targetId = requestedId !== undefined && requestedId !== null && requestedId !== ''
    ? requestedId
    : configuredId
  const candidates = []
  if (Array.isArray(terms)) candidates.push(...terms)
  if (Array.isArray(sourceConfig.terms)) candidates.push(...sourceConfig.terms)
  if (sourceConfig.currentTerm && typeof sourceConfig.currentTerm === 'object') candidates.push(sourceConfig.currentTerm)
  if (sourceConfig.term && typeof sourceConfig.term === 'object') candidates.push(sourceConfig.term)
  let descriptor = null
  if (targetId !== null && targetId !== undefined && targetId !== '') {
    descriptor = candidates.find(item => {
      const id = pick(item, ['id', 'term_id', 'termId', '_id'], null)
      return id !== null && id !== undefined && idKey(id) === idKey(targetId)
    }) || null
  }
  if (!descriptor && targetId === null && candidates.length === 1) descriptor = candidates[0]
  if (!descriptor && (sourceConfig.termStart || sourceConfig.termEnd || sourceConfig.term_start || sourceConfig.term_end)) {
    descriptor = sourceConfig
  }
  const range = dateRangeFromTerm(descriptor)
  const id = targetId !== null && targetId !== undefined && targetId !== ''
    ? targetId
    : (descriptor && pick(descriptor, ['id', 'term_id', 'termId', '_id'], null))
  const name = descriptor ? String(pick(descriptor, ['name', 'termName', 'term_name', 'label'], '') || '') : ''
  return { id: id == null ? null : id, name, descriptor, range }
}

function isInRange(date, range) {
  if (!date || !range) return true
  const time = date.getTime()
  return time >= range.start.getTime() && time < range.endExclusive.getTime()
}

function eventBelongsToTerm(record, term) {
  if (!term) return true
  const recordTerm = record.termId
  if (term.id !== null && term.id !== undefined && term.id !== '') {
    if (recordTerm !== null && recordTerm !== undefined && recordTerm !== '') return idKey(recordTerm) === idKey(term.id)
    // 旧记录没有 term_id 时，若配置有明确日期范围，用日期作兼容性归属判断。
    return Boolean(term.range && isInRange(record._created, term.range))
  }
  return term.range ? isInRange(record._created, term.range) : true
}

function makeRangeMeta(range, period, term) {
  const endInclusive = range.endInclusive || new Date(range.endExclusive.getTime() - 1)
  return {
    period,
    key: period === 'week' ? localDateKey(range.start) : (term && term.id != null ? idKey(term.id) : localDateKey(range.start)),
    start: range.start.toISOString(),
    end: endInclusive.toISOString(),
    endExclusive: range.endExclusive.toISOString(),
    startDate: localDateKey(range.start),
    endDate: localDateKey(endInclusive),
    label: `${localDateLabel(range.start)} - ${localDateLabel(endInclusive)}`
  }
}

function buildMemberRows(members, records) {
  const totals = {}
  members.forEach(member => {
    totals[idKey(member.id)] = {
      categories: zeroCategories(),
      positiveCategories: zeroCategories(),
      negativeCategories: zeroCategories(),
      positive: 0,
      negative: 0,
      count: 0,
      lastEvent: null
    }
  })
  records.forEach(record => {
    const bucket = totals[idKey(record.studentId)]
    if (!bucket) return
    const points = finiteNumber(record.points, 0)
    if (CATEGORIES.indexOf(record.category) < 0) return
    bucket.categories[record.category] += points
    bucket.count += 1
    if (points > 0) {
      bucket.positive += points
      bucket.positiveCategories[record.category] += points
    }
    if (points < 0) {
      bucket.negative += points
      bucket.negativeCategories[record.category] += points
    }
    if (!bucket.lastEvent || record._created.getTime() > bucket.lastEvent._created.getTime()) bucket.lastEvent = record
  })
  return members.map(member => {
    const bucket = totals[idKey(member.id)] || {
      categories: zeroCategories(),
      positiveCategories: zeroCategories(),
      negativeCategories: zeroCategories(),
      positive: 0,
      negative: 0,
      count: 0,
      lastEvent: null
    }
    const categories = categoryCopy(bucket.categories)
    const total = sumCategories(categories)
    return {
      id: member.id,
      student_id: member.id,
      name: member.name,
      groupId: member.groupId,
      group_id: member.groupId,
      group: member.group,
      groupName: member.groupName,
      active: member.active,
      sortOrder: member.sortOrder,
      joinedAt: member.joinedAt,
      color: member.color,
      studentNo: member.studentNo,
      categories,
      categoryTotals: categoryCopy(categories),
      total,
      score: total,
      positive: bucket.positive,
      negative: bucket.negative,
      positiveCategories: categoryCopy(bucket.positiveCategories),
      negativeCategories: categoryCopy(bucket.negativeCategories),
      count: bucket.count,
      lastEvent: bucket.lastEvent ? publicRecord(bucket.lastEvent) : null,
      _order: member._order
    }
  })
}

function publicRecord(record) {
  if (!record) return null
  const result = { ...record }
  delete result._created
  delete result._order
  return result
}

function buildGroupRows(memberRows, definedGroups) {
  const groups = {}
  ;(definedGroups || []).forEach(group => {
    const key = idKey(group.id)
    groups[key] = {
      id: group.id,
      group_id: group.id,
      groupId: group.id,
      name: group.name || '未分组',
      groupName: group.name || '未分组',
      categories: zeroCategories(),
      positiveCategories: zeroCategories(),
      negativeCategories: zeroCategories(),
      positive: 0,
      negative: 0,
      count: 0,
      members: [],
      _order: group.sortOrder
    }
  })
  memberRows.forEach(member => {
    const memberGroupId = member.groupId !== null && member.groupId !== undefined && member.groupId !== ''
      ? member.groupId
      : (member.group || '未分组')
    const key = idKey(memberGroupId)
    if (!groups[key]) {
      groups[key] = {
        id: memberGroupId,
        group_id: memberGroupId,
        groupId: memberGroupId,
        name: member.groupName || member.group || '未分组',
        groupName: member.groupName || member.group || '未分组',
        categories: zeroCategories(),
        positiveCategories: zeroCategories(),
        negativeCategories: zeroCategories(),
        positive: 0,
        negative: 0,
        count: 0,
        members: [],
        _order: member._order
      }
    }
    const group = groups[key]
    CATEGORIES.forEach(category => { group.categories[category] += finiteNumber(member.categories[category], 0) })
    CATEGORIES.forEach(category => {
      group.positiveCategories[category] += finiteNumber(member.positiveCategories && member.positiveCategories[category], 0)
      group.negativeCategories[category] += finiteNumber(member.negativeCategories && member.negativeCategories[category], 0)
    })
    group.positive += finiteNumber(member.positive, 0)
    group.negative += finiteNumber(member.negative, 0)
    group.count += finiteNumber(member.count, 0)
    group.members.push(member)
  })
  return Object.keys(groups).map(key => {
    const group = groups[key]
    const categories = categoryCopy(group.categories)
    const total = sumCategories(categories)
    const members = rankItems(group.members, 'total').map(member => ({ ...member, groupRank: member.rank }))
    return {
      id: group.id,
      group_id: group.group_id,
      groupId: group.groupId,
      name: group.name,
      groupName: group.groupName,
      categories,
      categoryTotals: categoryCopy(categories),
      total,
      score: total,
      positive: group.positive,
      negative: group.negative,
      positiveCategories: categoryCopy(group.positiveCategories),
      negativeCategories: categoryCopy(group.negativeCategories),
      count: group.count,
      memberCount: members.length,
      members,
      _order: group._order
    }
  })
}

function attachBadges(rows, badgeConfig) {
  return rows.map(row => ({
    ...row,
    badge: badgeFor(row.rank, badgeConfig)
  }))
}

function buildRankings(rows, badgeConfig) {
  const result = {}
  CATEGORIES.forEach(category => {
    result[category] = attachBadges(rankItems(rows, category), badgeConfig)
  })
  result.total = attachBadges(rankItems(rows, 'total'), badgeConfig)
  return result
}

function buildCategorySummary(records) {
  return CATEGORIES.map(category => {
    const related = records.filter(record => record.category === category)
    const total = related.reduce((sum, record) => sum + record.points, 0)
    const positive = related.filter(record => record.points > 0).reduce((sum, record) => sum + record.points, 0)
    const negative = related.filter(record => record.points < 0).reduce((sum, record) => sum + record.points, 0)
    return {
      key: category,
      category,
      label: CATEGORY_LABELS[category],
      total,
      score: total,
      positive,
      negative,
      count: related.length
    }
  })
}

function buildWeekOptions(records, selectedStart) {
  const buckets = {}
  const addWeek = (date, record) => {
    const weekRange = mondayRange(date)
    const key = localDateKey(weekRange.start)
    if (!buckets[key]) {
      buckets[key] = {
        key,
        value: key,
        date: key,
        start: weekRange.start.toISOString(),
        startDate: key,
        end: weekRange.endInclusive.toISOString(),
        endDate: localDateKey(weekRange.endInclusive),
        label: `${weekRange.start.getMonth() + 1}/${weekRange.start.getDate()} - ${weekRange.endInclusive.getMonth() + 1}/${weekRange.endInclusive.getDate()}`,
        categoryTotals: zeroCategories(),
        total: 0,
        score: 0,
        eventCount: 0,
        selected: false
      }
    }
    if (record) {
      buckets[key].categoryTotals[record.category] += record.points
      buckets[key].total += record.points
      buckets[key].score += record.points
      buckets[key].eventCount += 1
    }
  }
  ;(records || []).forEach(record => {
    if (!record || record.voided || CATEGORIES.indexOf(record.category) < 0 || !record._created) return
    addWeek(record._created, record)
  })
  if (selectedStart) addWeek(selectedStart, null)
  // 历史周选择器应能进入中间没有记分的周；在已知最早、最晚周之间补齐
  // 空周（最多 80 周，避免脏数据造成超长列表）。
  const knownStarts = Object.keys(buckets).map(key => parseDate(key)).filter(Boolean).sort((a, b) => a - b)
  if (knownStarts.length > 1) {
    const cursor = new Date(knownStarts[0].getTime())
    const last = knownStarts[knownStarts.length - 1]
    let count = 0
    while (cursor.getTime() <= last.getTime() && count < 80) {
      addWeek(cursor, null)
      cursor.setDate(cursor.getDate() + 7)
      count += 1
    }
  }
  const selectedKey = selectedStart ? localDateKey(mondayRange(selectedStart).start) : ''
  return Object.keys(buckets).sort((left, right) => right.localeCompare(left)).map(key => ({
    ...buckets[key],
    selected: key === selectedKey
  }))
}

function cleanRow(row) {
  const result = { ...row }
  delete result._order
  return result
}

function cleanGroup(group) {
  const result = cleanRow(group)
  result.members = (group.members || []).map(cleanRow)
  return result
}

function buildPeriodStats(sourceData, specification) {
  const { config, groups: definedGroups, members, events } = sourceData
  const period = specification.period
  const range = specification.range
  const term = specification.term || null
  const memberIds = {}
  members.forEach(member => { memberIds[idKey(member.id)] = true })
  const validRecords = events.filter(record => {
    if (record.voided || CATEGORIES.indexOf(record.category) < 0 || !memberIds[idKey(record.studentId)]) return false
    if (period === 'term') {
      // 有明确 term_id 的记录以 ID 为准；即使日期字段因补录而落在学期
      // 日期之外，也仍属于该学期。没有 term_id 的旧记录才使用日期兼容。
      if (term && term.id !== null && term.id !== undefined && term.id !== '') {
        if (record.termId !== null && record.termId !== undefined && record.termId !== '') {
          return idKey(record.termId) === idKey(term.id)
        }
        return Boolean(term.range && isInRange(record._created, term.range))
      }
      return isInRange(record._created, range)
    }
    return isInRange(record._created, range)
  })
  const memberRows = buildMemberRows(members, validRecords)
  const groupRows = buildGroupRows(memberRows, definedGroups)
  const badgeConfig = collectBadges(config)
  const rankings = buildRankings(memberRows, badgeConfig)
  const groupRankings = buildRankings(groupRows, badgeConfig)
  const total = validRecords.reduce((sum, record) => sum + record.points, 0)
  const positive = validRecords.filter(record => record.points > 0).reduce((sum, record) => sum + record.points, 0)
  const negative = validRecords.filter(record => record.points < 0).reduce((sum, record) => sum + record.points, 0)
  const average = members.length ? total / members.length : 0
  const categorySummary = buildCategorySummary(validRecords)
  const categoryTotals = categorySummary.reduce((map, item) => {
    map[item.key] = item.total
    return map
  }, zeroCategories())
  const weekSource = period === 'week'
    ? events.filter(record => !record.voided && CATEGORIES.indexOf(record.category) >= 0 && memberIds[idKey(record.studentId)])
    : validRecords
  const weeks = buildWeekOptions(weekSource, period === 'week' ? range.start : null)
  const cleanRankings = {}
  const cleanGroupRankings = {}
  CATEGORIES.concat(['total']).forEach(category => {
    cleanRankings[category] = rankings[category].map(cleanRow)
    cleanGroupRankings[category] = groupRankings[category].map(cleanGroup)
  })
  const ranking = cleanRankings.total
  const groups = cleanGroupRankings.total
  const result = {
    period,
    termId: term && term.id !== undefined ? term.id : null,
    term: term ? {
      id: term.id,
      name: term.name,
      startDate: term.range && term.range.startDate ? localDateKey(term.range.startDate) : '',
      endDate: term.range && term.range.endDate ? localDateKey(term.range.endDate) : ''
    } : null,
    range: makeRangeMeta(range, period, term),
    week: period === 'week' ? makeRangeMeta(range, period, term) : null,
    records: validRecords.map(publicRecord),
    events: validRecords.map(publicRecord),
    eventCount: validRecords.length,
    total,
    score: total,
    positive,
    negative,
    average,
    categories: categorySummary,
    categoryTotals,
    dimensions: categoryCopy(categoryTotals),
    weeks,
    ranking,
    students: ranking,
    rankings: cleanRankings,
    groups,
    groupRanking: groups,
    groupRankings: cleanGroupRankings,
    badgeConfig: clone(badgeConfig),
    badgesEnabled: badgeConfig.enabled,
    memberCount: memberRows.length,
    groupCount: groupRows.length
  }
  return result
}

function normalizeStatsArgs(dateOrOptions, maybeOptions) {
  if (dateOrOptions && typeof dateOrOptions === 'object' && !(dateOrOptions instanceof Date) && !(dateOrOptions instanceof String)) {
    return { ...dateOrOptions }
  }
  const options = maybeOptions && typeof maybeOptions === 'object' ? { ...maybeOptions } : {}
  options.date = dateOrOptions
  return options
}

function createScoreService(provider) {
  const source = provider || defaultStore
  const api = {
    CATEGORIES,
    CATEGORY_LABELS,

    // getWeekStats(date[, options])：date 可为 Date、时间字符串或时间戳。
    getWeekStats(dateOrOptions, maybeOptions) {
      const options = normalizeStatsArgs(dateOrOptions, maybeOptions)
      const range = mondayRange(options.date || new Date())
      const data = readSource(source)
      return buildPeriodStats(data, { period: 'week', range, term: null })
    },

    // getTermStats(termId[, options])：优先按 term_id 匹配；旧记录没有 term_id
    // 时，在存在 term 起止日期的情况下按日期兼容归属。
    getTermStats(termIdOrOptions, maybeOptions) {
      let requestedId = termIdOrOptions
      let options = maybeOptions || {}
      if (termIdOrOptions && typeof termIdOrOptions === 'object' && !(termIdOrOptions instanceof Date)) {
        options = termIdOrOptions
        requestedId = options.termId !== undefined ? options.termId : options.term_id
      }
      const data = readSource(source)
      const term = resolveTerm(data.config, data.terms, requestedId)
      const termRecords = term.id !== null && term.id !== undefined && term.id !== ''
        ? data.events.filter(record => idKey(record.termId) === idKey(term.id))
        : data.events
      const range = term.range || spanRange(termRecords)
      return buildPeriodStats(data, { period: 'term', range, term })
    },

    // 返回个人当前周、本学期及四维度累计，全部字段均来自同一份原始记录快照。
    getStudentStats(id, options) {
      const data = readSource(source)
      const member = data.members.find(item => idKey(item.id) === idKey(id))
      if (!member) return null
      const opts = options && typeof options === 'object' ? options : {}
      const weekRange = mondayRange(opts.date || new Date())
      const term = resolveTerm(data.config, data.terms, opts.termId !== undefined ? opts.termId : opts.term_id)
      const termRecords = term.id !== null && term.id !== undefined && term.id !== ''
        ? data.events.filter(record => idKey(record.termId) === idKey(term.id))
        : data.events
      const termRange = term.range || spanRange(termRecords)
      const weekStats = buildPeriodStats(data, { period: 'week', range: weekRange, term: null })
      const termStats = buildPeriodStats(data, { period: 'term', range: termRange, term })
      const weekRow = weekStats.ranking.find(item => idKey(item.id) === idKey(id))
      const termRow = termStats.ranking.find(item => idKey(item.id) === idKey(id))
      if (!weekRow || !termRow) return null
      const dimensions = CATEGORIES.map(category => ({
        key: category,
        category,
        label: CATEGORY_LABELS[category],
        week: weekRow.categories[category],
        term: termRow.categories[category],
        total: termRow.categories[category]
      }))
      return {
        id: member.id,
        student_id: member.id,
        name: member.name,
        group: member.group,
        groupId: member.groupId,
        group_id: member.groupId,
        student: cleanRow(member),
        week: cleanRow(weekRow),
        term: cleanRow(termRow),
        weekly: cleanRow(weekRow),
        semester: cleanRow(termRow),
        weekStats,
        termStats,
        weekTotal: weekRow.total,
        weekRank: weekRow.rank,
        weekRankLabel: weekRow.rankLabel,
        termTotal: termRow.total,
        termRank: termRow.rank,
        termRankLabel: termRow.rankLabel,
        categories: categoryCopy(termRow.categories),
        categoryTotals: categoryCopy(termRow.categories),
        dimensions,
        badge: termRow.badge || null,
        badges: { week: weekRow.badge || null, term: termRow.badge || null }
      }
    }
  }
  return api
}

const service = createScoreService(defaultStore)
service.createScoreService = createScoreService
service.isCategory = value => Boolean(canonicalCategory(value))
service._internals = {
  CATEGORIES,
  canonicalCategory,
  parseDate,
  mondayRange,
  normalizeGroup,
  normalizeMember,
  normalizeRecord,
  rankItems,
  collectBadges,
  buildPeriodStats,
  readSource
}

module.exports = service
