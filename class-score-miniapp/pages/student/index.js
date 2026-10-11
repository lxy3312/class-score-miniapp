const store = require('../../services/store.js')
const score = require('../../services/score.js')

const DIMENSIONS = [
  { key: 'study', label: '学习' },
  { key: 'sports', label: '体育' },
  { key: 'labor', label: '劳动' },
  { key: 'discipline', label: '纪律' }
]

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

function termIdFromConfig(config) {
  const source = config || {}
  if (source.currentTerm && typeof source.currentTerm === 'object') return source.currentTerm.id || source.currentTerm._id || ''
  if (source.term && typeof source.term === 'object') return source.term.id || source.term._id || ''
  return source.currentTermId || source.current_term_id || source.termId || source.term_id || ''
}

function periodView(source) {
  const item = source || {}
  const value = item.score !== undefined ? item.score : (item.total !== undefined ? item.total : 0)
  return {
    ...item,
    scoreValue: value,
    scoreClass: value >= 0 ? 'positive' : 'negative',
    rankText: item.rankLabel !== undefined ? item.rankLabel : (item.rank !== undefined ? String(item.rank) : '—'),
    badgeVisible: Boolean(item.badge && (item.badge.icon || item.badge.label)),
    badgeIcon: item.badge && item.badge.icon ? item.badge.icon : '',
    badgeLabel: item.badge && item.badge.label ? item.badge.label : ''
  }
}

function dimensionRows(result) {
  if (Array.isArray(result && result.dimensions)) return result.dimensions.map(item => ({
    ...item,
    key: item.key || item.category,
    initial: String(item.label || '').slice(0, 1),
    weekValue: item.week !== undefined ? item.week : 0,
    termValue: item.term !== undefined ? item.term : (item.total !== undefined ? item.total : 0)
  }))
  const week = result && result.week || {}
  const term = result && result.term || {}
  const weekSource = week.dimensions || week.categoryTotals || week.categories || {}
  const termSource = term.dimensions || term.categoryTotals || term.categories || result && result.categoryTotals || {}
  return DIMENSIONS.map(item => ({
    ...item,
    initial: item.label.slice(0, 1),
    weekValue: weekSource[item.key] !== undefined ? weekSource[item.key] : 0,
    termValue: termSource[item.key] !== undefined ? termSource[item.key] : 0
  }))
}

Page({
  data: {
    studentId: '',
    config: {},
    student: {},
    displayName: '',
    initials: '',
    week: {},
    term: {},
    dimensions: [],
    loading: true,
    errorMessage: ''
  },

  onLoad(options) {
    let studentId = options && options.id !== undefined ? options.id : ''
    try { studentId = decodeURIComponent(studentId) } catch (error) {}
    this.setData({ studentId })
    this.unsubscribe = store.subscribe(signal => this.refresh(signal))
    Promise.resolve(store.init())
      .then(() => this.loadStudent())
      .catch(error => this.setData({ loading: false, errorMessage: error.message || '个人积分加载失败，请稍后重试' }))
  },

  onShow() { if (this.data.studentId !== '') this.loadStudent() },
  onUnload() { if (this.unsubscribe) this.unsubscribe() },

  onPullDownRefresh() {
    Promise.resolve(store.refresh ? store.refresh() : null)
      .catch(() => {})
      .then(() => this.loadStudent())
      .catch(() => {})
      .then(() => wx.stopPullDownRefresh())
  },

  refresh(signal) {
    const status = storeStatus(signal)
    if (status.errorMessage) {
      this.setData({ loading: status.loading, errorMessage: status.errorMessage })
      return
    }
    this.loadStudent()
  },

  loadStudent() {
    if (this.data.studentId === '') {
      this.setData({ loading: false, errorMessage: '缺少学生 ID' })
      return
    }
    const config = (() => { try { return store.getConfig() || {} } catch (error) { return {} } })()
    let result
    try {
      result = score.getStudentStats(this.data.studentId, { date: new Date(), termId: termIdFromConfig(config) })
    } catch (error) {
      this.setData({ config, loading: false, errorMessage: error.message || '个人积分加载失败，请稍后重试' })
      return
    }
    Promise.resolve(result).then(data => {
      if (!data || !data.student) {
        this.setData({ config, loading: false, errorMessage: '没有找到这名同学' })
        return
      }
      const student = data.student
      const name = String(student.name || data.name || '未命名同学')
      const displayName = config.privacyMode === 'initial' ? `${name.slice(0, 1)}同学` : name
      const status = storeStatus()
      this.setData({
        config,
        student,
        displayName,
        initials: name.slice(0, 1),
        week: periodView(data.week || data.weekly),
        term: periodView(data.term || data.semester),
        dimensions: dimensionRows(data),
        loading: status.loading,
        errorMessage: status.errorMessage
      })
    }).catch(error => this.setData({ config, loading: false, errorMessage: error.message || '个人积分加载失败，请稍后重试' }))
  }
})
