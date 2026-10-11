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

function normalizeBadgeSettings(config) {
  const settings = config && config.settings && typeof config.settings === 'object' ? config.settings : {}
  const source = settings.badges && typeof settings.badges === 'object'
    ? settings.badges
    : (Array.isArray(settings.rules)
      ? settings
      : (config && config.badges && typeof config.badges === 'object' ? config.badges : {}))
  const rules = Array.isArray(source.rules) ? source.rules.map((rule, index) => ({
    ...rule,
    rank: Number(rule.rank),
    icon: String(rule.icon || ''),
    label: String(rule.label || ''),
    index
  })).filter(rule => Number.isInteger(rule.rank) && rule.rank > 0) : []
  return { enabled: source.enabled === true, rules }
}

Page({
  data: {
    config: {},
    draft: {},
    draftDirty: false,
    members: [],
    rules: [],
    showMemberForm: false,
    showRuleForm: false,
    showBadgeForm: false,
    showBatchForm: false,
    newMemberName: '',
    newMemberGroup: '',
    newRuleLabel: '',
    newRuleDelta: '1',
    badgeSettings: { enabled: false, rules: [] },
    badgeEditingIndex: -1,
    badgeRank: '',
    badgeIcon: '',
    badgeLabel: '',
    batchText: '',
    saving: false,
    savingMember: false,
    savingRule: false,
    savingMemberId: '',
    savingBadges: false,
    batchSaving: false,
    isAdmin: false,
    loading: true,
    errorMessage: '',
    openid: '',
    openidLoading: false
  },

  onLoad() {
    this.unsubscribe = store.subscribe(signal => this.refresh(signal))
    Promise.resolve()
      .then(() => store.init())
      .then(() => this.refresh())
      .catch(error => this.setData({ loading: false, errorMessage: error.message || '设置数据加载失败，请稍后重试' }))
  },
  onShow() { this.refresh() },
  onUnload() { if (this.unsubscribe) this.unsubscribe() },

  refresh(signal) {
    const status = storeStatus(signal)
    let config
    let members
    let rules
    try {
      config = store.getConfig()
      members = store.getMembers(true).map(member => ({ ...member, initials: member.name.slice(0, 1) }))
      rules = store.getRules()
    } catch (error) {
      this.setData({ isAdmin: currentRole(), loading: status.loading, errorMessage: status.errorMessage || error.message || '设置数据加载失败，请稍后重试' })
      return
    }
    const isAdmin = currentRole()
    // 保留用户正在编辑的草稿；后台监听/其它页面写入时不应让输入框跳回旧值。
    const syncDraft = !this.data.draftDirty || !isAdmin
    this.setData({ config, draft: syncDraft ? { ...config } : this.data.draft, draftDirty: syncDraft ? false : this.data.draftDirty, members, rules, badgeSettings: normalizeBadgeSettings(config), isAdmin, loading: status.loading, errorMessage: status.errorMessage, showMemberForm: isAdmin ? this.data.showMemberForm : false, showRuleForm: isAdmin ? this.data.showRuleForm : false, showBadgeForm: isAdmin ? this.data.showBadgeForm : false, showBatchForm: isAdmin ? this.data.showBatchForm : false })
  },

  ensureAdmin() {
    const isAdmin = currentRole()
    if (isAdmin) return true
    this.setData({ isAdmin: false, showMemberForm: false, showRuleForm: false, showBadgeForm: false, showBatchForm: false })
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

  onDraftInput(event) {
    if (!currentRole()) return
    const field = event.currentTarget.dataset.field
    const draft = { ...this.data.draft, [field]: event.detail.value }
    this.setData({ draft, draftDirty: true })
  },
  chooseDate(event) {
    if (!currentRole()) return
    const field = event.currentTarget.dataset.field
    this.setData({ draft: { ...this.data.draft, [field]: event.detail.value }, draftDirty: true })
  },

  async saveConfig() {
    if (!this.ensureAdmin()) return
    if (this.data.saving) return
    const draft = this.data.draft
    if (!String(draft.schoolName || '').trim() || !String(draft.className || '').trim()) { wx.showToast({ title: '学校和班级不能为空', icon: 'none' }); return }
    if (draft.termStart && draft.termEnd && new Date(draft.termStart) > new Date(draft.termEnd)) { wx.showToast({ title: '学期开始日期不能晚于结束日期', icon: 'none' }); return }
    this.setData({ saving: true })
    try {
      await store.updateConfig({ schoolName: String(draft.schoolName).trim(), className: String(draft.className).trim(), grade: String(draft.grade || '').trim(), termName: String(draft.termName || '').trim(), termStart: draft.termStart, termEnd: draft.termEnd })
      this.setData({ saving: false, draft: { ...store.getConfig() }, draftDirty: false })
      wx.showToast({ title: '班级资料已保存', icon: 'success' })
    } catch (error) {
      this.setData({ saving: false })
      await this.handleWriteError(error, '保存失败')
    }
  },

  async togglePrivacy(event) {
    if (!this.ensureAdmin()) return
    try {
      await store.updateConfig({ privacyMode: event.detail.value ? 'initial' : 'full' })
      wx.showToast({ title: event.detail.value ? '榜单将显示首字' : '榜单显示全名', icon: 'none' })
    } catch (error) { await this.handleWriteError(error, '保存失败') }
  },

  openMemberForm() { if (this.ensureAdmin()) this.setData({ showMemberForm: true, newMemberName: '', newMemberGroup: '', savingMember: false }) },
  closeMemberForm() { if (!this.data.savingMember) this.setData({ showMemberForm: false }) },
  stopBubble() {},
  onMemberInput(event) { if (currentRole()) this.setData({ [event.currentTarget.dataset.field]: event.detail.value }) },
  async saveMember() {
    if (!this.ensureAdmin()) return
    if (this.data.savingMember) return
    this.setData({ savingMember: true })
    try {
      const name = String(this.data.newMemberName || '').trim()
      const group = String(this.data.newMemberGroup || '未分组').trim() || '未分组'
      if (!name) throw new Error('请输入学生姓名')
      await store.addMember(name.slice(0, 30), group.slice(0, 40))
      this.setData({ showMemberForm: false })
      wx.showToast({ title: '已加入名单', icon: 'success' })
    } catch (error) {
      await this.handleWriteError(error, '添加失败')
    } finally {
      this.setData({ savingMember: false })
    }
  },
  async toggleMember(event) {
    if (!this.ensureAdmin()) return
    const memberId = event.currentTarget.dataset.id
    if (this.data.savingMemberId !== '') return
    this.setData({ savingMemberId: String(memberId) })
    try { await store.toggleMember(memberId, event.detail.value) }
    catch (error) { await this.handleWriteError(error, '保存失败'); this.refresh() }
    finally { this.setData({ savingMemberId: '' }) }
  },

  openRuleForm() { if (this.ensureAdmin()) this.setData({ showRuleForm: true, newRuleLabel: '', newRuleDelta: '1', savingRule: false }) },
  closeRuleForm() { if (!this.data.savingRule) this.setData({ showRuleForm: false }) },
  onRuleInput(event) { if (currentRole()) this.setData({ [event.currentTarget.dataset.field]: event.detail.value }) },
  async saveRule() {
    if (!this.ensureAdmin()) return
    if (this.data.savingRule) return
    const label = String(this.data.newRuleLabel || '').trim().slice(0, 30)
    const delta = Number(this.data.newRuleDelta)
    if (!label) {
      wx.showToast({ title: '请填写规则名称', icon: 'none' })
      return
    }
    if (!Number.isFinite(delta) || delta === 0) {
      wx.showToast({ title: '默认分值需为非零数字', icon: 'none' })
      return
    }
    this.setData({ savingRule: true })
    try {
      await store.addRule(label, delta)
      this.setData({ showRuleForm: false })
      wx.showToast({ title: '规则已添加', icon: 'success' })
    } catch (error) {
      await this.handleWriteError(error, '添加失败')
    } finally {
      this.setData({ savingRule: false })
    }
  },

  async saveBadgeSettings(next, successText) {
    if (this.data.savingBadges) return false
    this.setData({ savingBadges: true })
    try {
      await store.updateConfig({ settings: { badges: { enabled: next.enabled === true, rules: next.rules.map(rule => ({ rank: Number(rule.rank), icon: String(rule.icon || ''), label: String(rule.label || '') })) } } })
      this.setData({ badgeSettings: next })
      if (successText) wx.showToast({ title: successText, icon: 'success' })
      return true
    } finally {
      this.setData({ savingBadges: false })
    }
  },

  async toggleBadges(event) {
    if (!this.ensureAdmin()) return
    const next = { ...this.data.badgeSettings, enabled: event.detail.value === true }
    try { await this.saveBadgeSettings(next, next.enabled ? '徽章已开启' : '徽章已关闭') }
    catch (error) { await this.handleWriteError(error, '徽章设置保存失败'); this.refresh() }
  },

  openBadgeForm() {
    if (!this.ensureAdmin()) return
    this.setData({ showBadgeForm: true, badgeEditingIndex: -1, badgeRank: '', badgeIcon: '', badgeLabel: '' })
  },

  editBadgeRule(event) {
    if (!this.ensureAdmin()) return
    const index = Number(event.currentTarget.dataset.index)
    const rule = this.data.badgeSettings.rules[index]
    if (!rule) return
    this.setData({ showBadgeForm: true, badgeEditingIndex: index, badgeRank: String(rule.rank), badgeIcon: rule.icon, badgeLabel: rule.label })
  },

  closeBadgeForm() { if (!this.data.savingBadges) this.setData({ showBadgeForm: false }) },
  onBadgeInput(event) { if (currentRole()) this.setData({ [event.currentTarget.dataset.field]: event.detail.value }) },

  async saveBadgeRule() {
    if (!this.ensureAdmin()) return
    const rank = Number(this.data.badgeRank)
    const icon = String(this.data.badgeIcon || '').trim()
    const label = String(this.data.badgeLabel || '').trim()
    if (!Number.isInteger(rank) || rank < 1) { wx.showToast({ title: '名次必须是正整数', icon: 'none' }); return }
    if (!icon || !label) { wx.showToast({ title: '请填写图标和徽章文字', icon: 'none' }); return }
    const duplicateRank = this.data.badgeSettings.rules.some((rule, index) => Number(rule.rank) === rank && index !== this.data.badgeEditingIndex)
    if (duplicateRank) { wx.showToast({ title: '该名次已有徽章规则', icon: 'none' }); return }
    const rules = this.data.badgeSettings.rules.map(rule => ({ ...rule }))
    const value = { rank, icon, label }
    if (this.data.badgeEditingIndex >= 0) rules[this.data.badgeEditingIndex] = value
    else rules.push(value)
    try {
      const saved = await this.saveBadgeSettings({ enabled: this.data.badgeSettings.enabled, rules }, '徽章规则已保存')
      if (saved) this.setData({ showBadgeForm: false })
    } catch (error) { await this.handleWriteError(error, '徽章规则保存失败') }
  },

  removeBadgeRule(event) {
    if (!this.ensureAdmin()) return
    const index = Number(event.currentTarget.dataset.index)
    const rule = this.data.badgeSettings.rules[index]
    if (!rule) return
    wx.showModal({ title: '删除徽章规则？', content: `${rule.icon} ${rule.label}`, confirmColor: '#e36369', success: async result => {
      if (!result.confirm || !this.ensureAdmin()) return
      const rules = this.data.badgeSettings.rules.filter((item, itemIndex) => itemIndex !== index)
      try { await this.saveBadgeSettings({ enabled: this.data.badgeSettings.enabled, rules }, '徽章规则已删除') }
      catch (error) { await this.handleWriteError(error, '删除失败') }
    } })
  },

  openBatchForm() { if (this.ensureAdmin()) this.setData({ showBatchForm: true, batchText: '', batchSaving: false }) },
  closeBatchForm() { if (!this.data.batchSaving) this.setData({ showBatchForm: false }) },
  closeOverlays() {
    if (this.data.savingMember || this.data.savingRule || this.data.savingBadges || this.data.batchSaving) return
    this.setData({ showMemberForm: false, showRuleForm: false, showBadgeForm: false, showBatchForm: false })
  },
  onBatchInput(event) { if (currentRole()) this.setData({ batchText: event.detail.value }) },
  async importBatch() {
    if (!this.ensureAdmin()) return
    if (this.data.batchSaving) return
    const lines = String(this.data.batchText || '').split(/\n/).map(item => item.trim()).filter(Boolean)
    if (!lines.length) { wx.showToast({ title: '请先粘贴名单', icon: 'none' }); return }
    this.setData({ batchSaving: true })
    let added = 0
    let failed = 0
    let stopped = false
    let firstFailure = null
    let baseSortOrder = 0
    let realtimePaused = false
    try { baseSortOrder = store.getMembers(true).length } catch (error) {}
    if (typeof store.pauseRealtime === 'function') {
      store.pauseRealtime()
      realtimePaused = true
    }
    try {
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex]
        // 支持“姓名 组别”“序号 姓名 组别”和逗号/制表符分隔；不去重，
        // 这样附件中同名学生仍会按两个独立名额分配自增 ID。
        const parts = line.replace(/[,，\t]/g, ' ').split(/\s+/).filter(Boolean)
        if (/^\d+[.、)]?$/.test(parts[0] || '')) parts.shift()
        const groupPattern = /^(一|二|三|四|五|六|七|八|九|十)组$/
        const groupToken = parts.length > 1 && groupPattern.test(parts[parts.length - 1]) ? parts.pop() : '未分组'
        const name = parts.join('').slice(0, 30)
        if (!name) { failed += 1; continue }
        try {
          // 批量过程中暂缓全量刷新，最后统一拉取一次；显式传入排序值，
          // 避免延迟刷新时每行都拿到相同的本地名单长度。
          await store.addMember(name, groupToken, {
            refresh: false,
            notify: false,
            sortOrder: baseSortOrder + added + failed
          })
          added += 1
        } catch (error) {
          failed += 1
          if (!firstFailure) firstFailure = error
          if (forbidden(error)) {
            await this.handleWriteError(error, '导入失败')
            stopped = true
            break
          }
        }
      }
    } catch (error) {
      if (!firstFailure) firstFailure = error
    }
    try {
      // 无论中途是否有单行失败，都让界面回到云端最新快照。
      await store.refresh(true)
    } catch (error) {
      if (!firstFailure) firstFailure = error
    } finally {
      // 等唯一一次主动刷新完成后再恢复监听，避免最后一条写入的晚到回调
      // 又排队出第二次全量读取；刷新失败时也能可靠释放暂停状态。
      if (realtimePaused) {
        store.resumeRealtime(false)
        realtimePaused = false
      }
      this.setData({ showBatchForm: false, batchSaving: false })
    }
    // 权限错误已经由统一错误处理提示，避免后面的“导入失败”提示覆盖它。
    if (stopped) return
    if (firstFailure && !stopped && !added) {
      await this.handleWriteError(firstFailure, '导入失败')
      return
    }
    if (failed) {
      wx.showToast({ title: `已导入 ${added} 人，${failed} 行失败`, icon: 'none' })
    } else {
      wx.showToast({ title: `成功导入 ${added} 人`, icon: 'success' })
    }
  },

  async exportData() {
    try {
      const csv = await store.exportCsv()
      wx.setClipboardData({ data: csv, success: () => wx.showToast({ title: 'CSV 已复制到剪贴板', icon: 'success' }) })
    } catch (error) { await this.handleWriteError(error, '导出失败') }
  },

  async showOpenid() {
    if (this.data.openidLoading) return
    this.setData({ openidLoading: true })
    try {
      const app = getApp()
      let result
      if (app && typeof app.whoami === 'function') result = await app.whoami()
      else if (app && typeof app.refreshRole === 'function') result = await app.refreshRole()
      const info = result && result.result ? result.result : (result || {})
      const openid = info.openid || (app && app.globalData && app.globalData.openid) || ''
      if (!openid) throw new Error('暂时无法获取 openid，请稍后重试')
      this.setData({ openid, isAdmin: currentRole() })
    } catch (error) {
      wx.showToast({ title: error.message || '获取 openid 失败', icon: 'none' })
    } finally { this.setData({ openidLoading: false }) }
  },

  copyOpenid() {
    if (!this.data.openid) return
    wx.setClipboardData({ data: this.data.openid, success: () => wx.showToast({ title: 'openid 已复制', icon: 'success' }) })
  }
})
