const store = require('./services/store.js')
const cloud = require('./services/cloud-adapter.js')

// 必填：在微信开发者工具「云开发 -> 设置 -> 环境设置」中复制环境 ID 到这里。
const CLOUD_ENV_ID = 'cloudbase-d9gxek4i448d8dae8'
// 必填：在 classConfig 集合中新建班级文档，并把该文档的 _id 填到这里。
const CLASS_ID = '2612439e6a9a118801d171b720b78eef'

const globalData = {
  store,
  role: 'viewer',
  openid: '',
  cloudEnvId: CLOUD_ENV_ID,
  classId: CLASS_ID,
  lastSyncAt: null
}

// 页面只从这里读取身份。该值永远由 whoami 的服务端结果派生，不能在本地修改。
Object.defineProperty(globalData, 'isAdmin', {
  enumerable: true,
  get() { return this.role === 'admin' }
})

App({
  globalData,

  onLaunch() {
    store.configure({
      envId: CLOUD_ENV_ID,
      classId: CLASS_ID,
      adapter: cloud,
      onForbidden: () => this.refreshIdentity()
    })

    // onLaunch 不能阻塞首屏，页面可通过 getApp().ready 等待首次云端加载。
    this.ready = this.initializeCloud()
  },

  async initializeCloud() {
    this.globalData.role = 'viewer'
    this.globalData.openid = ''

    if (!cloud.isConfigurationValid(CLOUD_ENV_ID, CLASS_ID)) {
      return store.init()
    }

    try {
      // 云初始化放在入口，确保后续 whoami 与数据库读取使用同一环境。
      wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: true })
      cloud.init(CLOUD_ENV_ID, { alreadyInitialized: true })
    } catch (error) {
      store.reportError(error)
      return store.getSnapshot()
    }

    // 身份判定失败时 refreshIdentity 会保持 viewer，绝不提升为管理员。
    await this.refreshIdentity()
    const snapshot = await store.init()
    this.globalData.lastSyncAt = snapshot.status && snapshot.status.lastSyncAt
      ? snapshot.status.lastSyncAt
      : new Date().toISOString()
    return snapshot
  },

  async refreshIdentity() {
    this.globalData.role = 'viewer'
    try {
      const identity = await cloud.whoami()
      this.globalData.openid = identity && identity.openid ? identity.openid : ''
      // 没有服务端确认的 openid 时，即使返回体被篡改为 isAdmin=true，也只能是浏览者。
      this.globalData.role = this.globalData.openid && identity && identity.isAdmin === true ? 'admin' : 'viewer'
      return { openid: this.globalData.openid, isAdmin: this.globalData.isAdmin }
    } catch (error) {
      this.globalData.openid = ''
      this.globalData.role = 'viewer'
      return { openid: '', isAdmin: false, error: error.message || '身份识别失败' }
    }
  },

  // 页面统一通过这两个入口重新读取服务端身份；兼容设置页/记分页的旧调用名。
  async refreshRole() {
    return this.refreshIdentity()
  },

  async whoami() {
    return this.refreshIdentity()
  },

  async refreshSnapshot() {
    const snapshot = await store.refresh()
    this.globalData.lastSyncAt = snapshot.status && snapshot.status.lastSyncAt
      ? snapshot.status.lastSyncAt
      : this.globalData.lastSyncAt
    return snapshot
  },

  onHide() {
    // 应用进入后台时关闭 watch，回到前台由页面刷新并重新建立监听。
    if (store && typeof store.stopRealtime === 'function') store.stopRealtime()
    this.shouldResumeCloud = true
  },

  onShow() {
    // 首次启动由 initializeCloud 负责；仅在真正从后台返回时重新拉取并恢复 watch。
    if (!this.shouldResumeCloud) return
    this.shouldResumeCloud = false
    Promise.resolve(this.ready)
      .then(() => store.refresh(true))
      .catch(error => store.reportError(error))
  }
})
