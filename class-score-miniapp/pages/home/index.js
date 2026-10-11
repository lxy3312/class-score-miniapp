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

function currentRole() {
  let app
  try { app = getApp() } catch (error) { app = null }
  const value = app && app.globalData ? app.globalData.isAdmin : false
  return typeof value === 'function' ? value() === true : value === true
}

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

function displayName(item, config, isGroup) {
  const name = String(item && (item.name || item.groupName || item.group || '') || '')
  if (!name) return isGroup ? '未分组' : '未命名同学'
  if (!isGroup && config && config.privacyMode === 'initial') return `${name.slice(0, 1)}同学`
  return name
}

function normalizeWeeks(stats, selectedDate) {
  const source = stats && Array.isArray(stats.weeks) ? stats.weeks : []
  const result = source.map((item, index) => {
    if (typeof item === 'string') return { value: item, label: item }
    const value = item && (item.value || item.date || item.startDate || item.start || item.key)
    const label = item && (item.label || item.title || item.name || item.rangeLabel)
    return { ...item, value: value || selectedDate, label: label || `第${index + 1}周` }
  }).filter(item => item.value)
  return result.length ? result : [{ value: selectedDate, label: '本周' }]
}

function scoreValue(item) {
  if (!item) return 0
  return item.score !== undefined ? item.score : (item.total !== undefined ? item.total : 0)
}

function rankingSource(stats, dimension, viewMode) {
  const key = dimension || 'total'
  if (viewMode === 'groups') {
    const grouped = stats && stats.groupRankings && stats.groupRankings[key]
    return Array.isArray(grouped) ? grouped : (Array.isArray(stats && stats.groups) ? stats.groups : [])
  }
  const ranked = stats && stats.rankings && stats.rankings[key]
  if (Array.isArray(ranked)) return ranked
  if (Array.isArray(stats && stats.students)) return stats.students
  return Array.isArray(stats && stats.ranking) ? stats.ranking : []
}

function decorateRows(rows, config, isGroup) {
  return (rows || []).map((item, index) => {
    const score = scoreValue(item)
    return {
      ...item,
      displayName: displayName(item, config, isGroup),
      scoreValue: score,
      scoreClass: score >= 0 ? 'positive' : 'negative',
      rankText: item.rankLabel !== undefined ? item.rankLabel : (item.rank !== undefined ? String(item.rank) : '—'),
      groupText: isGroup ? `${item.memberCount !== undefined ? item.memberCount : (item.members ? item.members.length : '')} 人` : String(item.groupName || item.group || '未分组'),
      initials: String(item.name || item.groupName || item.group || '?').slice(0, 1),
      color: item.color || PALETTE[index % PALETTE.length],
      badgeVisible: Boolean(item.badge && (item.badge.icon || item.badge.label)),
      badgeIcon: item.badge && item.badge.icon ? item.badge.icon : '',
      badgeLabel: item.badge && item.badge.label ? item.badge.label : ''
    }
  })
}

Page({
  data: {
    config: {},
    period: 'week',
    periodLabel: '本周',
    dimension: 'total',
    dimensions: DIMENSIONS,
    viewMode: 'students',
    selectedDate: localDateKey(new Date()),
    weekIndex: 0,
    weekOptions: [],
    selectedWeekLabel: '本周',
    stats: {},
    dimensionCards: [],
    ranking: [],
    podium: [],
    query: '',
    isAdmin: false,
    loading: true,
    errorMessage: '',
    activeCount: 0,
    groupCount: 0
  },

  onLoad() {
    this.unsubscribe = store.subscribe(signal => this.refresh(signal))
    Promise.resolve(store.init())
      .then(() => this.loadStats())
      .catch(error => this.setData({ loading: false, errorMessage: error.message || '班级数据加载失败，请稍后重试' }))
  },

  onShow() { this.loadStats() },

  onUnload() {
    if (this.unsubscribe) this.unsubscribe()
  },

  onPullDownRefresh() {
    Promise.resolve(store.refresh ? store.refresh() : null)
      .catch(() => {})
      .then(() => this.loadStats())
      .catch(() => {})
      .then(() => wx.stopPullDownRefresh())
  },

  loadStats() {
    const config = (() => { try { return store.getConfig() || {} } catch (error) { return {} } })()
    const selectedDate = this.data.selectedDate || localDateKey(new Date())
    let result
    try {
      result = this.data.period === 'term'
        ? score.getTermStats(termIdFromConfig(config))
        : score.getWeekStats(selectedDate)
    } catch (error) {
      const status = storeStatus()
      this.setData({ config, isAdmin: currentRole(), loading: status.loading, errorMessage: status.errorMessage || error.message || '班级数据加载失败，请稍后重试' })
      return
    }
    Promise.resolve(result).then(stats => this.applyStats(stats || {}, config)).catch(error => {
      this.setData({ config, isAdmin: currentRole(), loading: false, errorMessage: error.message || '班级数据加载失败，请稍后重试' })
    })
  },

  refresh(signal) {
    const status = storeStatus(signal)
    if (status.errorMessage) {
      this.setData({ isAdmin: currentRole(), loading: status.loading, errorMessage: status.errorMessage })
      return
    }
    this.loadStats()
  },

  applyStats(stats, config) {
    const isGroup = this.data.viewMode === 'groups'
    const weeks = normalizeWeeks(stats, this.data.selectedDate)
    const currentWeekKey = stats.week && (stats.week.startDate || stats.week.key)
    const selectedDateIndex = weeks.findIndex(item => String(item.value) === String(this.data.selectedDate))
    const currentWeekIndex = weeks.findIndex(item => String(item.value) === String(currentWeekKey))
    const selectedIndex = selectedDateIndex >= 0 ? selectedDateIndex : currentWeekIndex
    const resolvedWeekIndex = selectedIndex >= 0 ? selectedIndex : 0
    const selectedDate = this.data.period === 'week' && weeks[resolvedWeekIndex]
      ? weeks[resolvedWeekIndex].value
      : this.data.selectedDate
    const source = rankingSource(stats, this.data.dimension, this.data.viewMode)
    const allRows = decorateRows(source, config, isGroup)
    const query = String(this.data.query || '').trim().toLowerCase()
    const ranking = query
      ? allRows.filter(item => String(item.name || '').toLowerCase().includes(query) || String(item.groupName || item.group || '').toLowerCase().includes(query))
      : allRows
    const dimensionCards = this.data.dimensions.filter(item => item.key !== 'total').map(item => ({ ...item, value: (stats.dimensions && stats.dimensions[item.key] !== undefined) ? stats.dimensions[item.key] : (stats.categoryTotals ? stats.categoryTotals[item.key] : 0) }))
    const periodLabel = this.data.period === 'term' ? '本学期' : (stats.week && stats.week.label ? stats.week.label : '本周')
    const status = storeStatus()
    this.setData({
      config,
      stats,
      weekOptions: weeks,
      weekIndex: resolvedWeekIndex,
      selectedWeekLabel: weeks[resolvedWeekIndex].label,
      selectedDate,
      ranking,
      podium: allRows.slice(0, 3),
      dimensionCards,
      periodLabel,
      isAdmin: currentRole(),
      loading: status.loading,
      errorMessage: status.errorMessage,
      activeCount: stats.memberCount !== undefined ? stats.memberCount : (stats.students || []).length,
      groupCount: stats.groupCount !== undefined ? stats.groupCount : (stats.groups || []).length
    })
  },

  selectPeriod(event) {
    const period = event.currentTarget.dataset.period
    this.setData({ period, periodLabel: period === 'term' ? '本学期' : '本周' }, () => this.loadStats())
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

  onSearchInput(event) {
    this.setData({ query: event.detail.value }, () => this.loadStats())
  },

  clearSearch() {
    this.setData({ query: '' }, () => this.loadStats())
  },

  openStudent(event) {
    if (this.data.viewMode !== 'students') return
    const id = event.currentTarget.dataset.id
    if (id === undefined || id === null || id === '') return
    wx.navigateTo({ url: `/pages/student/index?id=${encodeURIComponent(id)}` })
  },

  openRecords() { wx.switchTab({ url: '/pages/records/index' }) },
  openStats() { wx.switchTab({ url: '/pages/stats/index' }) },
  openSettings() { wx.switchTab({ url: '/pages/settings/index' }) },
  openAdd() {
    if (!currentRole()) {
      this.setData({ isAdmin: false })
      wx.showToast({ title: '没有管理员权限', icon: 'none' })
      return
    }
    try { wx.setStorageSync('class_score_open_composer', true) } catch (error) {}
    wx.switchTab({ url: '/pages/records/index' })
  }
})
