import _ from 'lodash'
import moment from 'moment'
import { api, db } from '#models'
import axios from 'axios'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { Config } from '#components'
import { randomBytes } from 'crypto'

const steamIdOffset = 76561197960265728n
/**
 * 将好友码或steamID转换成steamID
 * @param {string} id 好友码或steamID
 * @returns {string} steamID
 */
export function getSteamId (id) {
  if (!id) {
    return false
  }
  id = BigInt(id)
  if (id < steamIdOffset) {
    id = id + steamIdOffset
  }
  return id.toString()
}

/**
 * 将steamID转换成好友码
 * @param {string} steamId
 * @returns {string}
 */
export function getFriendCode (steamId) {
  if (!steamId) {
    return false
  }
  steamId = BigInt(steamId)
  return (steamId - steamIdOffset).toString()
}

/**
 * 优先使用缓存的完整地址，否则沿用旧 CDN 资源路径。
 * 此函数不调用 appdetails；发送/渲染图片请使用 getHeaderImageByAppid。
 * @param {string|number} appid
 * @returns {Promise<string>}
 */
export async function getHeaderImgUrlByAppid (appid) {
  if (!isAppid(appid)) return ''
  const info = await getGameSchineseInfo([appid])
  return headerUrl(appid, info[String(appid)]?.header)
}

function isAppid (appid) {
  return !!appid && /^\d{1,10}$/.test(String(appid))
}

function isHeaderUrl (header) {
  if (typeof header !== 'string') return false
  try {
    return ['http:', 'https:'].includes(new URL(header).protocol)
  } catch {
    return false
  }
}

function headerUrl (appid, header) {
  if (isHeaderUrl(header)) return header
  const file = typeof header === 'string' && header && header !== 'false' && header !== '0' ? header : 'header.jpg'
  return 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/' + appid + '/' + file
}

/** 将渲染用的 data URL 转为消息适配器通用的 Buffer。 */
export function headerImageFile (source) {
  return typeof source === 'string' && source.startsWith('data:image/')
    ? Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')
    : source
}

const headerRequests = new Map()
const headerFailures = new Map()
const imageQueue = []
let activeImages = 0

async function withImageSlot (fn) {
  if (activeImages >= 3) await new Promise(resolve => imageQueue.push(resolve))
  else activeImages++
  try {
    return await fn()
  } finally {
    const next = imageQueue.shift()
    if (next) next()
    else activeImages--
  }
}

// 下载一次并复用数据，避免渲染器/适配器再次下载同一张封面。
async function downloadHeader (url) {
  if (!isHeaderUrl(url)) return ''
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: (Number(Config.steam.timeout) || 5) * 1000,
      httpAgent: Config.steam.proxy ? new HttpProxyAgent(Config.steam.proxy) : undefined,
      httpsAgent: Config.steam.proxy ? new HttpsProxyAgent(Config.steam.proxy) : undefined
    })
    const buffer = Buffer.from(response.data)
    // 某些代理会以 HTTP 200 返回 HTML 错误页，不能只判断状态码。
    let mime = ''
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) mime = 'image/jpeg'
    else if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png'
    else if (/^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) mime = 'image/gif'
    else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp'
    return mime ? 'data:' + mime + ';base64,' + buffer.toString('base64') : ''
  } catch {
    return ''
  }
}

/**
 * 获取可直接用于渲染/发送的封面数据。旧地址下载失败才查询 appdetails。
 * @param {string|number} appid
 * @param {import('models/db/game').GameColumns|null} cached 批量预取结果；null 表示没有记录
 * @returns {Promise<string>} 图片 data URL，失败时为空
 */
export async function getHeaderImageByAppid (appid, cached) {
  if (!isAppid(appid)) return ''
  appid = String(appid)
  if ((headerFailures.get(appid) || 0) > Date.now()) return ''
  headerFailures.delete(appid)
  if (headerRequests.has(appid)) return headerRequests.get(appid)
  const pending = withImageSlot(async () => {
    const info = cached === undefined ? (await getGameSchineseInfo([appid]))[appid] : cached
    const url = headerUrl(appid, info?.header)
    const image = await downloadHeader(url)
    if (image) return image
    const details = await api.store.appdetails(appid)
    const actualUrl = details.header_image
    const actualImage = actualUrl !== url ? await downloadHeader(actualUrl) : ''
    if (!actualImage) return ''
    const game = { appid, name: details.name || info?.name || appid, header: actualUrl }
    // 图片已成功下载，数据库写入失败也不丢弃本次结果。
    try {
      if (info) await db.game.set(appid, game)
      else await db.game.add([game])
    } catch { /* ignore */ }
    return actualImage
  }).catch(() => '').then(image => {
    if (!image) {
      const until = Date.now() + 60 * 1000
      headerFailures.set(appid, until)
      const timer = setTimeout(() => {
        if (headerFailures.get(appid) === until) headerFailures.delete(appid)
      }, 60 * 1000)
      timer.unref?.()
    }
    return image
  }).finally(() => headerRequests.delete(appid))
  headerRequests.set(appid, pending)
  return pending
}

/**
 * 获取静态资源url
 * - items/xxx
 * - apps/xxx
 * - replayxxx
 * @param {string} path
 * @returns {string}
 */
export function getStaticUrl (path) {
  if (!path) return ''
  if (['items', 'apps'].some(item => path.startsWith(item))) {
    // return `https://cdn.fastly.steamstatic.com/steamcommunity/public/images/${path}`
    return `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/${path}`
  } else if (path.startsWith('replay')) {
    // return `https://shared.cloudflare.steamstatic.com/social_sharing/${path}`
    return `https://shared.akamai.steamstatic.com/social_sharing/${path}`
  } else if (path.startsWith('steam')) {
    // return `https://steamcdn-a.akamaihd.net/${path}`
    // return `https://shared.cloudflare.steamstatic.com/store_item_assets/${path}`
    return `https://shared.akamai.steamstatic.com/store_item_assets/${path}`
  } else {
    return `https://clan.fastly.steamstatic.com/images/${path}`
  }
}

/**
 * 将用户状态码转换为中文
 * @param {number} state
 * @returns {string}
 */
export function getPersonaState (state) {
  const stateMap = {
    0: '离线',
    1: '在线',
    3: '离开',
    4: '离开'
  }
  return stateMap[state] || '其他'
}

/**
 * 解码access_token中的jwt
 * @param {string} jwt
 * @returns {jwtInfo}
 * @typedef {Object} jwtInfo
 * @property {string} iss - 发行者（issuer）。
 * @property {string} sub - 用户的 Steam ID。
 * @property {string[]} aud - 接收者（audience）。
 * @property {number} exp - Access Token 的过期时间（UNIX 时间戳）。
 * @property {number} nbf - Access Token 的生效时间（UNIX 时间戳）。
 * @property {number} iat - Access Token 的刷新时间（UNIX 时间戳）。
 * @property {string} jti - Access Token 的唯一标识符（JWT ID）。
 * @property {number} oat - Access Token 的生成时间（UNIX 时间戳）。
 * @property {number} rt_exp - Refresh Token 的过期时间（UNIX 时间戳）。
 * @property {number} per - 权限（permission level）。
 * @property {string} ip_subject - 与 Access Token 关联的 IP 地址（主）。
 * @property {string} ip_confirmer - 与 Access Token 关联的 IP 地址（确认者）。
 */
export function decodeAccessTokenJwt (jwt) {
  const parts = jwt.split('.')
  if (parts.length != 3) {
    return false
  }

  const standardBase64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')

  return JSON.parse(Buffer.from(standardBase64, 'base64').toString('utf8'))
}

/**
 * 获取对应用户的token信息
 * @param {string} userId
 * @param {string?} steamId
 * @returns {Promise<{
 *   success: boolean,
 *   message?: string,
 *   accessToken?: string,
 *   cookie?: string
 *   steamId?: string
 * }>}
 */
export async function getAccessToken (userId, steamId) {
  if (!userId) {
    return {
      success: false,
      message: 'userId不能为空'
    }
  }
  if (!steamId) {
    steamId = await db.user.getBind(userId)
    if (!steamId) {
      return {
        success: false,
        message: Config.tips.noSteamIdTips
      }
    }
  }
  const token = await db.token.getByUserIdAndSteamId(userId, steamId)
  if (!token) {
    return {
      success: false,
      message: Config.tips.noAccessTokenTips
    }
  }
  try {
    return {
      success: true,
      ...await refreshAccessToken(token)
    }
  } catch (error) {
    return {
      success: false,
      message: error.message
    }
  }
}

/**
 * 刷新access_token
 * @param {import('models/db').token.TokenColumns|string} token token列或uid
 * @param {boolean} force 是否强制刷新
 * @returns {Promise<import('models/db').token.TokenColumns|null>}
 */
export async function refreshAccessToken (token, force = false) {
  if (typeof token === 'string') {
    const steamId = await db.user.getBind(token)
    if (!steamId) {
      return null
    }
    token = await db.token.getByUserIdAndSteamId(token, steamId)
  }
  if (!token) return null
  const now = moment().unix()
  // 提前30分钟刷新access_token
  const exp = token.accessTokenExpires - 60 * 30
  const isExpired = exp < now
  if (!isExpired && token.cookie && !force) return token
  // 判断refresh_token是否过期
  const rtExp = token.refreshTokenExpires - 60 * 30
  if (rtExp < now) {
    await db.token.del(token.userId, token.steamId)
    throw new Error('refresh_token已过期, 请重新登录')
  }
  const accessToken = (isExpired || force) ? (await api.IAuthenticationService.GenerateAccessTokenForApp(token.refreshToken, token.steamId)).access_token : token.accessToken
  if (!accessToken) throw new Error('刷新access_token失败')
  const cookie = getCookie(token.steamId, accessToken)
  return await db.token.set(token.userId, accessToken, cookie)
}

/**
 * 通过steamId和accessToken生成cookie
 * @param {string} steamId
 * @param {string} accessToken
 * @returns {string}
 */
export function getCookie (steamId, accessToken) {
  const cookieValue = encodeURIComponent([steamId, accessToken].join('||'))
  const sessionId = randomBytes(12).toString('hex')
  return [`steamLoginSecure=${cookieValue}`, `sessionid=${sessionId}`].join('; ')
}

/**
 * 获取用户相关信息
 * @param {string|string[]} steamIds
 * @returns {Promise<{
*   steamid: string,
*   communityvisibilitystate: number,
*   profilestate: number,
*   personaname: string,
*   avatar: string,
*   avatarmedium: string,
*   avatarfull: string,
*   lastlogoff?: number,
*   personastate: number,
*   timecreated: string,
*   gameid?: string,
*   gameextrainfo?: string,
*   community_icon?: string
*   header?: string
* }[]>}
*/
export async function getUserSummaries (steamIds) {
  if (_.isEmpty(steamIds)) return []
  let type = Math.floor(Number(Config.push.pushApi)) || 2
  if (type > 4 || type < 1) type = 2
  if (type === 4) {
    type = _.random(1, 3)
  }
  if (type === 1) {
    let accessToken = null
    const tokenList = await db.token.getAll()
    while (!accessToken) {
      const token = _.sample(tokenList)
      if (!token) {
        break
      }
      _.pull(tokenList, token)
      accessToken = await refreshAccessToken(token)
    }
    if (accessToken) {
      const data = await api.ISteamUserOAuth.GetUserSummaries(accessToken, steamIds).catch(err => {
        if ([429, 401, 403].includes(err.status)) {
          logger.info(`请求 ISteamUserOAuth.GetUserSummaries/v2 失败: ${err.status} 尝试使用 ISteamUser.GetPlayerSummaries/v2`)
          return false
        }
        throw err
      })
      if (data !== false) {
        const names = await getGameSchineseInfo(data.map(i => i.gameid))
        return data.map(i => {
          const info = names[i.gameid]
          if (info) {
            i.gameextrainfo = info.name
            i.header = info.header
          }
          return i
        })
      }
    }
    type = 2
  }
  if (type === 2) {
    const data = await api.ISteamUser.GetPlayerSummaries(steamIds).catch(err => {
      if (err.status === 429) {
        logger.info('请求 ISteamUser/GetPlayerSummaries/v2 失败: 429 尝试使用 IPlayerService.GetPlayerLinkDetails 接口不同返回的参数会有不同')
        return false
      }
      throw err
    })
    if (data !== false) {
      const names = await getGameSchineseInfo(data.map(i => i.gameid))
      return data.map(i => {
        const info = names[i.gameid]
        if (info) {
          i.gameextrainfo = info.name
          i.header = info.header
        }
        return i
      })
    }
  }
  return await api.IPlayerService.GetPlayerLinkDetails(steamIds).then(async res => {
    // 非steam游戏会返回 17579876560805036032 不知道是不是固定的
    const appids = res.map(i => i.private_data.game_id).filter(id => id && String(id).length <= 10)
    const appInfo = {}
    if (appids.length) {
      Object.assign(appInfo, await getGameSchineseInfo(appids))
    }
    return res.map(i => {
      const avatarhash = Buffer.from(i.public_data.sha_digest_avatar, 'base64').toString('hex')
      const gameid = i.private_data.game_id
      const info = appInfo[gameid] || {}
      const gameextrainfo = info.name
      return {
        steamid: i.public_data.steamid,
        communityvisibilitystate: i.public_data.visibility_state,
        profilestate: i.public_data.profile_state,
        personaname: i.public_data.persona_name,
        avatar: `https://avatars.steamstatic.com/${avatarhash}.jpg`,
        avatarmedium: `https://avatars.steamstatic.com/${avatarhash}_medium.jpg`,
        avatarfull: `https://avatars.steamstatic.com/${avatarhash}_full.jpg`,
        avatarhash,
        personastate: i.private_data.persona_state ?? 0,
        timecreated: i.private_data.time_created,
        gameid: (gameid && String(gameid).length <= 10) ? gameid : undefined,
        gameextrainfo,
        lastlogoff: i.private_data.last_logoff_time,
        header: info.header
        // TODO: 展示在好友列表的小图标
        // community_icon: appInfo[gameid]?.assets?.community_icon
      }
    })
  })
}

/**
 * 获取状态对应的颜色
 * @param {number} state
 * @returns {string}
 */
export function getStateColor (state) {
  switch (Number(state)) {
    case 1:
      return '#beee11'
    case 0:
      return '#999999'
    default:
      return '#8fbc8b'
  }
}

/**
 * 批量获取游戏名称和封面资源路径，SQLite 缓存 3 天
 * @param {string[]} appids
 * @returns {Promise<{[appid: string]: import('models/db/game').GameColumns}>}
 */
export async function getGameSchineseInfo (appids) {
  appids = _.uniq(appids.filter(isAppid).map(String))
  if (!appids.length) return {}
  let appInfo = {}
  try {
    appInfo = await db.game.get(appids)
    const now = moment().unix()
    const refreshIds = appids.filter(appid => {
      const cached = appInfo[appid]
      const updatedAt = cached && moment(cached.updatedAt).unix()
      return !cached || !Number.isFinite(updatedAt) || now - updatedAt > 3 * 24 * 60 * 60
    })
    if (!refreshIds.length) return appInfo
    // 恢复批量请求；只有封面下载失败才在 getHeaderImageByAppid 中查询 appdetails。
    const infos = await api.IStoreBrowseService.GetItems(refreshIds, { include_assets: true })
    const newGames = []
    for (const appid of refreshIds) {
      const info = infos[appid]
      if (!info) continue
      const cached = appInfo[appid]
      const game = {
        appid,
        name: info.name,
        community: info.assets?.community_icon,
        // 已验证的完整地址优先保留；相对路径仍按原逻辑使用。
        header: isHeaderUrl(cached?.header) ? cached.header : info.assets?.header
      }
      if (cached) await db.game.set(appid, game)
      else newGames.push(game)
      appInfo[appid] = { ...cached, ...game }
    }
    if (newGames.length) await db.game.add(newGames)
    return appInfo
  } catch (error) {
    return appInfo
  }
}

/**
 * 生成价格信息 用于制作图片
 * @param {Object} price IStoreBrowseService.GetItem().best_purchase_option 的格式 后续再兼容其他的
 * @param {boolean} isFree
 * @returns {{
 *   original: string,
 *   discount?: number,
 *   current?: string
 * }}
 */
export function generatePrice (price, isFree = false) {
  return price?.discount_pct
    ? {
        original: price.formatted_original_price,
        discount: price.discount_pct,
        current: price.formatted_final_price
      }
    : {
        original: isFree ? '免费开玩' : price?.formatted_final_price || ''
      }
}

/**
 * 数字对应的语言中文
 * @param {number} elanguage
 * @returns {string}
 */
export function getElanguageCN (elanguage) {
  return [
    '英语',
    '德语',
    '法语',
    '意大利语',
    '韩语',
    '西班牙语',
    '简体中文',
    '繁体中文',
    '俄语',
    '泰语',
    '日语',
    '葡萄牙语（巴西）',
    '波兰语',
    '丹麦语',
    '荷兰语',
    '芬兰语',
    '挪威语',
    '瑞典语',
    '匈牙利语',
    '捷克语',
    '罗马尼亚语',
    '土耳其语',
    '葡萄牙语（葡萄牙）',
    '保加利亚语',
    '希腊语',
    '不知道',
    '乌克兰语',
    '西班牙语（拉丁美洲）',
    '越南语',
    '不知道',
    '印尼语'
  ][elanguage] || '不知道'
}
