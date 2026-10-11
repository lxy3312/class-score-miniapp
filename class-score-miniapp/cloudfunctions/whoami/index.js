/**
 * 返回当前微信用户身份。此函数不接收客户端参数，班级由云函数环境变量
 * CLASS_ID 指定，值必须与小程序 app.js 中的 CLASS_ID 完全一致。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const CLASS_ID = String(process.env.CLASS_ID || '').trim()

exports.main = async () => {
  const wxContext = cloud.getWXContext()
  const openid = String(wxContext.OPENID || '')

  if (!openid) {
    return {
      openid: '',
      isAdmin: false,
      code: 'IDENTITY_UNAVAILABLE',
      message: '无法获取当前用户的 openid'
    }
  }

  if (!CLASS_ID) {
    return {
      openid,
      isAdmin: false,
      code: 'CLOUD_CLASS_ID_REQUIRED',
      message: 'whoami 云函数未配置 CLASS_ID 环境变量，当前已降级为浏览模式'
    }
  }

  let config
  try {
    const result = await db.collection('classConfig').doc(CLASS_ID).get()
    config = result && result.data
  } catch (error) {
    config = null
  }

  if (!config) {
    return {
      openid,
      isAdmin: false,
      code: 'CLASS_CONFIG_NOT_FOUND',
      message: '班级配置不存在，请先创建 classConfig 文档，并填写 schoolName、className、managers（openid 字符串数组）'
    }
  }

  const managers = Array.isArray(config.managers)
    ? config.managers.filter(item => typeof item === 'string')
    : []

  return { openid, isAdmin: managers.includes(openid) }
}
