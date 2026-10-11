const store = require('../../services/store.js')
const score = require('../../services/score.js')

const DIMENSIONS = [
  { key: 'total', label: '总分' },
  { key: 'study', label: '学习' },
  { key: 'sports', label: '体育' },
  { key: 'labor', label: '劳动' },
  { key: 'discipline', label: '纪律' }
]
const PALETTE = ['#5B8DEF', '#8B7CF6', '#53B6A4', '#F39B63', '#E78A9B', '#6B9BCF']

function storeStatus(signal) {
  let status = signal
  if (typeof store.getStatus === 'function') {
    try { status = store.getStatus() || signal } catch (error) {}
  }
  const error = status && (status.error || status.errorMessage)
  return {
    loading: Boolean(status && (status.loading === true || status.status === 'loading')),
    errorMessage: error ? String(error.message || error.errMsg || error) : ''
  }
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function termIdFromConfig(config) {
  const source = config || {}
  if (source.currentTerm && typeof source.currentTerm === 'object') return source.currentTerm.id || source.currentTerm._id || ''
  if (source.term && typeof source.term === 'object') return source.term.id || source.term._id || ''
  return source.currentTermId || source.current_term_id || source.termId || source.term_id || ''
}

function normalizeWeeks(stats, selectedDate) {
  const source = stats && Array.isArray(stats.weeks) ? stats.weeks : []
  const result = source.map((item, index) => {
    if (typeof item === 'string') return { value: item, label: item }
    const value = item && (item.value || item.date || item.startDate || item.start || item.key)
    const label = item && (item.label || item.title || item.name || item.rangeLabel)
    return { ...item, value: value || selectedDate, label: label || `第${index + 1}周` }
  }).filter(item => item.value)
  if (result.length) return result
  const week = stats && (stats.week || stats.range)
  return [{ value: week && (week.startDate || week.start) || selectedDate, label: week && week.label || '本周' }]
}

function rankingSource(stats, dimension, viewMode) {
  const key = dimension || 'total'
  if (viewMode === 'groups') {
    const grouped = stats && stats.groupRankings && stats.groupRankings[key]
    return Array.isArray(grouped) ? grouped : (Array.isArray(stats && stats.groups) ? stats.groups : [])
  }
  const ranked = stats && stats.rankings && stats.rankings[key]
  if (Array.isArray(ranked)) return ranked
  return Array.isArray(stats && stats.students) ? stats.students : (Array.isArray(stats && stats.ranking) ? stats.ranking : [])
}

function decorateRows(rows, isGroup, dimension) {
  return (rows || []).map((item, index) => {
    const value = item.score !== undefined ? item.score : (item.total !== undefined ? item.total : 0)
    const positiveValue = dimension && dimension !== 'total' && item.positiveCategories
      ? item.positiveCategories[dimension] || 0
      : (item.positive !== undefined ? item.positive : 0)
    const negativeValue = dimension && dimension !== 'total' && item.negativeCategories
      ? item.negativeCategories[dimension] || 0
      : (item.negative !== undefined ? item.negative : 0)
    return {
      ...item,
      displayName: String(item.name || item.groupName || item.group || (isGroup ? '未分组' : '未命名同学')),
      groupText: isGroup ? `${item.memberCount !== undefined ? item.memberCount : (item.members ? item.members.length : '')} 人` : String(item.groupName || item.group || '未分组'),
      scoreValue: value,
      scoreClass: value >= 0 ? 'positive' : 'negative',
      rankText: item.rankLabel !== undefined ? item.rankLabel : (item.rank !== undefined ? String(item.rank) : '—'),
      initials: String(item.name || item.groupName || item.group || '?').slice(0, 1),
      color: item.color || PALETTE[index % PALETTE.length],
      positiveValue,
      negativeValue,
      badgeVisible: Boolean(item.badge && (item.badge.icon || item.badge.label)),
      badgeIcon: item.badge && item.badge.icon ? item.badge.icon : '',
      badgeLabel: item.badge && item.badge.label ? item.badge.label : ''
    }
  })
}

function normalizeCategories(stats) {
  if (stats && Array.isArray(stats.categories)) return stats.categories.map(item => ({
    ...item,
    key: item.key || item.category,
    value: item.total !== undefined ? item.total : item.score,
    positiveValue: item.positive !== undefined ? item.positive : 0,
    negativeValue: item.negative !== undefined ? item.negative : 0
  }))
  const source = stats && (stats.dimensions || stats.categoryTotals || {})
  return DIMENSIONS.filter(item => item.key !== 'total').map(item => ({ ...item, value: source[item.key] !== undefined ? source[item.key] : 0, positiveValue: 0, negativeValue: 0, count: 0 }))
}

Page({
  data: {
    period: 'week',
    periodLabel: '本周',
    dimension: 'total',
    dimensions: DIMENSIONS,
    viewMode: 'students',
    selectedDate: localDateKey(new Date()),
    weekIndex: 0,
    weekOptions: [],
    selectedWeekLabel: '本周',
    config: {},
    stats: {},
    categories: [],
    ranking: [],
    loading: true,
    errorMessage: ''
  },

  onLoad() {
    this.unsubscribe = store.subscribe(signal => this.refresh(signal))
    Promise.resolve(store.init())
      .then(() => this.loadStats())
      .catch(error => this.setData({ loading: false, errorMessage: error.message || '统计数据加载失败，请稍后重试' }))
  },

  onShow() { this.loadStats() },
  onUnload() { if (this.unsubscribe) this.unsubscribe() },

  onPullDownRefresh() {
    Promise.resolve(store.refresh ? store.refresh() : null)
      .catch(() => {})
      .then(() => this.loadStats())
      .catch(() => {})
      .then(() => wx.stopPullDownRefresh())
  },

  loadStats() {
    const config = (() => { try { return store.getConfig() || {} } catch (error) { return {} } })()
    let result
    try {
      result = this.data.period === 'term'
        ? score.getTermStats(termIdFromConfig(config))
        : score.getWeekStats(this.data.selectedDate || localDateKey(new Date()))
    } catch (error) {
      const status = storeStatus()
      this.setData({ config, loading: status.loading, errorMessage: status.errorMessage || error.message || '统计数据加载失败，请稍后重试' })
      return
    }
    Promise.resolve(result).then(stats => this.applyStats(stats || {}, config)).catch(error => {
      this.setData({ config, loading: false, errorMessage: error.message || '统计数据加载失败，请稍后重试' })
    })
  },

  refresh(signal) {
    const status = storeStatus(signal)
    if (status.errorMessage) {
      this.setData({ loading: status.loading, errorMessage: status.errorMessage })
      return
    }
    this.loadStats()
  },

  applyStats(stats, config) {
    const weeks = normalizeWeeks(stats, this.data.selectedDate)
    const currentWeekKey = stats.week && (stats.week.startDate || stats.week.key)
    const selectedDateIndex = weeks.findIndex(item => String(item.value) === String(this.data.selectedDate))
    const currentWeekIndex = weeks.findIndex(item => String(item.value) === String(currentWeekKey))
    const selectedIndex = selectedDateIndex >= 0 ? selectedDateIndex : currentWeekIndex
    const resolvedWeekIndex = selectedIndex >= 0 ? selectedIndex : 0
    const resolvedDate = this.data.period === 'week' && weeks[resolvedWeekIndex]
      ? weeks[resolvedWeekIndex].value
      : this.data.selectedDate
    const source = rankingSource(stats, this.data.dimension, this.data.viewMode)
    const status = storeStatus()
    this.setData({
      config,
      stats,
      categories: normalizeCategories(stats),
      ranking: decorateRows(source, this.data.viewMode === 'groups', this.data.dimension),
      weekOptions: weeks,
      weekIndex: resolvedWeekIndex,
      selectedWeekLabel: weeks[resolvedWeekIndex].label,
      selectedDate: resolvedDate,
      periodLabel: this.data.period === 'term' ? (stats.term && stats.term.name || config.termName || '本学期') : (stats.range && stats.range.label || '本周'),
      loading: status.loading,
      errorMessage: status.errorMessage
    })
  },

  selectPeriod(event) {
    this.setData({ period: event.currentTarget.dataset.period }, () => this.loadStats())
  },

  selectDimension(event) {
    this.setData({ dimension: event.currentTarget.dataset.dimension }, () => this.loadStats())
  },

  selectView(event) {
    this.setData({ viewMode: event.currentTarget.dataset.view }, () => this.loadStats())
  },

  selectWeek(event) {
    const index = Number(event.detail.value) || 0
    const option = this.data.weekOptions[index]
    if (!option) return
    this.setData({ weekIndex: index, selectedDate: option.value, selectedWeekLabel: option.label }, () => this.loadStats())
  },

  openStudent(event) {
    if (this.data.viewMode !== 'students') return
    const id = event.currentTarget.dataset.id
    if (id === undefined || id === null || id === '') return
    wx.navigateTo({ url: `/pages/student/index?id=${encodeURIComponent(id)}` })
  },

  exportCsv() {
    try {
      const csv = store.exportCsv()
      wx.setClipboardData({ data: csv, success: () => wx.showToast({ title: '流水 CSV 已复制', icon: 'success' }) })
    } catch (error) {
      wx.showToast({ title: error.message || '导出失败', icon: 'none' })
    }
  }
})
