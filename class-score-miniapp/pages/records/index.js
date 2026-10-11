const store = require('../../services/store.js')

function currentRole() {
  let app
  try { app = getApp() } catch (e) { app = null }
  const value = app && app.globalData ? app.globalData.isAdmin : false
  return typeof value === 'function' ? value() === true : value === true
}

function storeStatus(signal) {
  let status = signal
  if (typeof store.getStatus === 'function') {
    try { status = store.getStatus() || signal } catch (e) {}
  }
  const error = status && (status.error || status.errorMessage)
  return {
    loading: Boolean(status && (status.loading === true || status.status === 'loading')),
    errorMessage: error ? String(error.message || error.errMsg || error) : ''
  }
}

function forbidden(error) {
  const result = error && error.result
  const code = error && (error.code || error.errCode || error.errorCode)
  const nestedCode = result && (result.code || result.errCode || result.errorCode)
  const message = `${error && (error.message || error.errMsg) || ''} ${result && (result.message || result.errMsg) || ''}`
  return code === 'FORBIDDEN' || nestedCode === 'FORBIDDEN' || message.includes('FORBIDDEN') || message.includes('没有管理员权限')
}

const CATEGORY_BY_LABEL = {
  课堂表现: 'study',
  作业完成: 'study',
  卫生值日: 'labor',
  劳动: 'labor',
  活动贡献: 'sports',
  体育: 'sports',
  纪律提醒: 'discipline',
  纪律: 'discipline'
}
const ALLOWED_CATEGORIES = ['study', 'sports', 'labor', 'discipline']
const CATEGORY_LABELS = {
  study: '学习',
  sports: '体育',
  labor: '劳动',
  discipline: '纪律'
}

function categoryForRule(rule) {
  if (!rule) return 'study'
  const candidate = rule.category || rule.code || CATEGORY_BY_LABEL[rule.label] || 'study'
  return ALLOWED_CATEGORIES.includes(candidate) ? candidate : 'study'
}

function formatDate(value) {
  const date = new Date(value)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

function formatClock(value) {
  const date = new Date(value)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

Page({
  data: {
    config: {},
    isAdmin: false,
    loading: true,
    errorMessage: '',
    filter: 'all',
    filterLabel: '全部记录',
    events: [],
    members: [],
    rules: [],
    showComposer: false,
    mode: 'add',
    memberIndex: 0,
    memberInitial: '',
    ruleIndex: 0,
    selectedPoints: 2,
    customPoints: '',
    reason: '',
    note: '',
    submitting: false,
    showEditForm: false,
    editingEvent: null,
    editPoints: '',
    editReason: '',
    editNote: '',
    savingEdit: false,
    quickAdd: [1, 2, 3, 5],
    quickDeduct: [1, 2, 3, 5]
  },

  onLoad() {
    this.unsubscribe = store.subscribe(signal => this.refresh(signal))
    Promise.resolve()
      .then(() => store.init())
      .then(() => this.refresh())
      .catch(error => this.setData({ loading: false, errorMessage: error.message || '记分数据加载失败，请稍后重试' }))
  },

  onShow() {
    this.refresh()
    let shouldOpen = false
    try { shouldOpen = wx.getStorageSync('class_score_open_composer') === true } catch (e) {}
    if (shouldOpen) {
      wx.removeStorageSync('class_score_open_composer')
      setTimeout(() => this.openComposer(), 120)
    }
  },

  onUnload() { if (this.unsubscribe) this.unsubscribe() },

  onPullDownRefresh() {
    const stop = () => wx.stopPullDownRefresh()
    Promise.resolve(store.refresh(true)).then(stop, stop)
  },

  refresh(signal) {
    const status = storeStatus(signal)
    let config
    let members
    let sourceEvents
    let rules
    try {
      config = store.getConfig()
      members = store.getMembers(true)
      sourceEvents = store.getEvents()
      rules = store.getRules()
    } catch (error) {
      this.setData({ isAdmin: currentRole(), loading: status.loading, errorMessage: status.errorMessage || error.message || '记分数据加载失败，请稍后重试' })
      return
    }
    const memberMap = {}
    members.forEach(member => { memberMap[member.id] = member })
    const events = sourceEvents.filter(event => {
      if (event.deleted) return false
      const points = Number(event.delta !== undefined ? event.delta : event.points) || 0
      return this.data.filter === 'all' || (this.data.filter === 'add' ? points > 0 : points < 0)
    }).map((event, index, list) => {
      const memberId = event.memberId !== undefined ? event.memberId : event.student_id
      const points = Number(event.delta !== undefined ? event.delta : event.points) || 0
      const occurredAt = event.occurredAt || event.created_at
      const member = memberMap[memberId]
      const previous = list[index - 1]
      const previousTime = previous && (previous.occurredAt || previous.created_at)
      const showDate = !previous || formatDate(previousTime) !== formatDate(occurredAt)
      return {
        ...event,
        memberId,
        delta: points,
        occurredAt,
        memberName: member ? member.name : '已归档学生',
        memberColor: member ? member.color : '#9ba5b5',
        initials: member ? member.name.slice(0, 1) : '?',
        categoryLabel: CATEGORY_LABELS[event.category] || event.category || '未分类',
        deltaText: points > 0 ? `+${points}` : String(points),
        deltaClass: points > 0 ? 'positive' : 'negative',
        dateLabel: showDate ? (formatDate(occurredAt) === formatDate(new Date()) ? '今天' : formatDate(occurredAt)) : '',
        timeLabel: formatClock(occurredAt),
        statusLabel: event.voided ? '已撤销' : ''
      }
    })
    const isAdmin = currentRole()
    this.setData({ config, isAdmin, members: members.filter(item => item.active), rules, events, loading: status.loading, errorMessage: status.errorMessage, showComposer: isAdmin ? this.data.showComposer : false, showEditForm: isAdmin ? this.data.showEditForm : false })
  },

  ensureAdmin() {
    const isAdmin = currentRole()
    if (isAdmin) return true
    this.setData({ isAdmin: false, showComposer: false })
    wx.showToast({ title: '没有管理员权限', icon: 'none' })
    return false
  },

  async handleWriteError(error, fallback) {
    if (forbidden(error)) {
      // store.runWrite 已统一提示并刷新一次服务端身份，页面只同步当前视图。
      this.refresh()
      return
    }
    wx.showToast({ title: error && (error.message || error.errMsg) || fallback, icon: 'none' })
  },

  setFilter(event) {
    const filter = event.currentTarget.dataset.filter
    this.setData({ filter, filterLabel: filter === 'add' ? '加分记录' : filter === 'deduct' ? '扣分记录' : '全部记录' }, () => this.refresh())
  },

  openComposer() {
    if (!this.ensureAdmin()) return
    const members = this.data.members.length ? this.data.members : store.getMembers(false)
    const rules = this.data.rules.length ? this.data.rules : store.getRules()
    if (!members.length) { wx.showToast({ title: '请先在设置中启用至少一名学生', icon: 'none' }); return }
    this.setData({ showComposer: true, mode: 'add', memberIndex: 0, memberInitial: members[0] ? members[0].name.slice(0, 1) : '?', ruleIndex: 0, selectedPoints: rules[0] ? Math.abs(rules[0].defaultDelta) || 1 : 2, customPoints: '', reason: '', note: '', members, rules })
  },

  closeComposer() { if (!this.data.submitting) this.setData({ showComposer: false }) },

  openEdit(event) {
    if (!this.ensureAdmin()) return
    const id = event.currentTarget.dataset.id
    const target = this.data.events.find(item => String(item.id) === String(id))
    if (!target || target.voided) return
    this.setData({
      showEditForm: true,
      editingEvent: target,
      editPoints: String(target.points !== undefined ? target.points : target.delta),
      editReason: target.reason || '',
      editNote: target.note || ''
    })
  },

  closeEdit() { if (!this.data.savingEdit) this.setData({ showEditForm: false, editingEvent: null }) },

  onEditInput(event) {
    if (!currentRole()) return
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value })
  },

  async saveEdit() {
    if (!this.ensureAdmin() || this.data.savingEdit) return
    const target = this.data.editingEvent
    if (!target) return
    const points = Number(this.data.editPoints)
    const reason = String(this.data.editReason || '').trim()
    if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 20) {
      wx.showToast({ title: '分值需为 -20 至 20 的整数', icon: 'none' })
      return
    }
    if (!reason) { wx.showToast({ title: '请填写记分原因', icon: 'none' }); return }
    this.setData({ savingEdit: true })
    try {
      await store.updateEvent(target.id, { points, reason, note: this.data.editNote })
      this.setData({ savingEdit: false, showEditForm: false, editingEvent: null })
      wx.showToast({ title: '记录已更新', icon: 'success' })
    } catch (error) {
      this.setData({ savingEdit: false })
      await this.handleWriteError(error, '修改失败')
    }
  },

  deleteEvent(event) {
    if (!this.ensureAdmin()) return
    const id = event.currentTarget.dataset.id
    const target = this.data.events.find(item => String(item.id) === String(id))
    if (!target || target.voided) return
    wx.showModal({ title: '删除这条记录？', content: '删除采用软删除并保留审计痕迹，统计会立即重算。', confirmColor: '#e36369', success: async result => {
      if (!result.confirm || !this.ensureAdmin()) return
      try {
        await store.deleteEvent(id)
        wx.showToast({ title: '记录已删除', icon: 'success' })
      } catch (error) { await this.handleWriteError(error, '删除失败') }
    } })
  },

  stopBubble() {},

  switchMode(event) {
    const mode = event.currentTarget.dataset.mode
    this.setData({ mode, customPoints: '', selectedPoints: mode === 'add' ? 2 : 1 })
  },

  pickMember(event) {
    const memberIndex = Number(event.detail.value) || 0
    const member = this.data.members[memberIndex]
    this.setData({ memberIndex, memberInitial: member ? member.name.slice(0, 1) : '?' })
  },
  pickRule(event) {
    const ruleIndex = Number(event.detail.value) || 0
    const rule = this.data.rules[ruleIndex]
    this.setData({ ruleIndex, reason: this.data.reason || (rule ? rule.label : '') })
  },
  chooseQuick(event) { this.setData({ selectedPoints: Number(event.currentTarget.dataset.value), customPoints: '' }) },
  onCustomPoints(event) { this.setData({ customPoints: event.detail.value }) },
  onReason(event) { this.setData({ reason: event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.value ? event.currentTarget.dataset.value : event.detail.value }) },
  onNote(event) { this.setData({ note: event.detail.value }) },

  submitScore() {
    if (!this.ensureAdmin()) return
    if (this.data.submitting) return
    const raw = this.data.customPoints === '' ? this.data.selectedPoints : Number(this.data.customPoints)
    const magnitude = Math.abs(Number(raw))
    const reason = String(this.data.reason || '').trim()
    if (!magnitude || !Number.isFinite(magnitude)) { wx.showToast({ title: '请输入分值', icon: 'none' }); return }
    if (!reason) { wx.showToast({ title: '请填写记分原因', icon: 'none' }); return }
    const member = this.data.members[this.data.memberIndex]
    const rule = this.data.rules[this.data.ruleIndex]
    if (!member) { wx.showToast({ title: '请选择学生', icon: 'none' }); return }
    const delta = this.data.mode === 'add' ? magnitude : -magnitude
    const actionText = delta > 0 ? `为 ${member.name} 加 ${magnitude} 分` : `扣除 ${member.name} ${magnitude} 分`
    const commit = async () => {
      if (!this.ensureAdmin()) return
      this.setData({ submitting: true })
      try {
        await store.addEvent({ memberId: member.id, delta, reason, note: this.data.note, ruleId: rule ? rule.id : '', category: categoryForRule(rule), operatorName: '班主任' })
        this.setData({ showComposer: false, submitting: false, reason: '', note: '' }, () => {
          wx.showToast({ title: delta > 0 ? '加分成功' : '扣分成功', icon: 'success' })
        })
      } catch (error) {
        this.setData({ submitting: false })
        await this.handleWriteError(error, '提交失败')
      }
    }
    wx.showModal({ title: '确认记分', content: `${actionText}\n原因：${reason}`, confirmColor: '#3157d5', success: result => { if (result.confirm) commit() } })
  },

  voidEvent(event) {
    if (!this.ensureAdmin()) return
    const id = event.currentTarget.dataset.id
    wx.showModal({ title: '撤销这条记录？', content: '撤销后会保留审计痕迹，统计将即时重算。', confirmColor: '#e36369', success: async result => {
      if (!result.confirm) return
      if (!this.ensureAdmin()) return
      try {
        await store.voidEvent(id)
        wx.showToast({ title: '已撤销', icon: 'success' })
      } catch (error) {
        await this.handleWriteError(error, '撤销失败')
      }
    } })
  }
})
