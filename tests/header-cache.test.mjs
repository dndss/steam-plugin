import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { SourceTextModule, SyntheticModule } from 'node:vm'
import * as path from 'node:path'

// Run with: node --experimental-vm-modules --test tests/header-cache.test.mjs
// Load the real modules with isolated service boundaries; no live bot or database is modified.
async function load (file, imports) {
  const mod = new SourceTextModule(await readFile(new URL('../' + file, import.meta.url), 'utf8'))
  await mod.link(async name => {
    const values = imports[name]
    assert.ok(values, 'Unexpected import: ' + name)
    return new SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value)
    })
  })
  await mod.evaluate()
  return mod.namespace
}

const now = Date.parse('2026-09-06T00:00:00Z')
const fresh = new Date(now).toISOString()
const old = new Date(now - 4 * 86400000).toISOString()
const header = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/4733380/5d9157553df9e173c81ea28985d12c274df65a9b/header.jpg?t=1788564846'
const lodash = { uniq: xs => [...new Set(xs)] }
const moment = value => ({ unix: () => Math.floor((value === undefined ? now : Date.parse(value)) / 1000) })

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const image = 'data:image/png;base64,' + png.toString('base64')

async function fixture (initial = {}, overrides = {}) {
  const rows = structuredClone(initial), calls = [], batches = [], downloads = [], writes = []
  const db = { game: {
    get: async ids => Object.fromEntries(ids.filter(id => rows[id]).map(id => [id, { ...rows[id] }])),
    add: async games => { for (const game of games) { writes.push(game); rows[game.appid] = { ...game, updatedAt: fresh } } },
    set: async (id, game) => { writes.push(game); rows[id] = { ...rows[id], ...game, updatedAt: fresh } }
  } }
  const api = {
    store: { appdetails: async id => { calls.push(id); return overrides.details ? overrides.details(id) : { name: 'FlowTrak Demo', header_image: header } } },
    IStoreBrowseService: { GetItems: async ids => {
      batches.push(ids)
      if (overrides.batch) return overrides.batch(ids)
      return Object.fromEntries(ids.map(id => [id, { name: 'Game ' + id, assets: { header: 'header.jpg', community_icon: 'icon' } }]))
    } }
  }
  const steam = await load('models/utils/steam.js', {
    lodash: { default: lodash }, moment: { default: moment },
    '#models': { api, db }, '#components': { Config: { steam: { timeout: 5 } } }, crypto: { randomBytes: () => {} },
    axios: { default: { get: async url => { downloads.push(url); return { data: overrides.download ? await overrides.download(url) : png } } } },
    'http-proxy-agent': { HttpProxyAgent: class {} }, 'https-proxy-agent': { HttpsProxyAgent: class {} }
  })
  return { steam, rows, calls, batches, downloads, writes }
}

test('20 cold-cache covers use one bulk metadata request and zero appdetails requests', async () => {
  const { steam, batches, calls, downloads } = await fixture()
  const ids = Array.from({ length: 20 }, (_, i) => String(i + 1))
  const info = await steam.getGameSchineseInfo(ids)
  const images = await Promise.all(ids.map(id => steam.getHeaderImageByAppid(id, info[id])))
  assert.ok(images.every(result => result === image))
  assert.deepEqual(batches, [ids])
  assert.equal(calls.length, 0)
  assert.equal(downloads.length, 20)
})

test('only a failed cover requests appdetails, validates it, and caches the complete URL', async () => {
  const { steam, rows, calls, batches, downloads } = await fixture({}, {
    download: async url => { if (url.endsWith('/4733380/header.jpg')) throw Error('404'); return png }
  })
  const info = await steam.getGameSchineseInfo(['570', '4733380'])
  await Promise.all(['570', '4733380'].map(id => steam.getHeaderImageByAppid(id, info[id])))
  assert.deepEqual(calls, ['4733380'])
  assert.equal(rows['4733380'].header, header)
  assert.equal(rows['4733380'].name, 'FlowTrak Demo')
  downloads.length = 0
  assert.equal(await steam.getHeaderImageByAppid('4733380'), image)
  assert.deepEqual(downloads, [header])
  assert.equal(batches.length, 1)
  assert.equal(calls.length, 1)
  assert.deepEqual(steam.headerImageFile(image), png)
})

test('fresh relative paths are valid cache entries; only expired metadata is batch-refreshed', async () => {
  const { steam, rows, batches, calls } = await fixture({
    1: { appid: '1', name: 'Fresh', header: 'hash/header.jpg', updatedAt: fresh },
    2: { appid: '2', name: 'Old', header, updatedAt: old },
    3: { appid: '3', name: 'Old', header: 'header.jpg', updatedAt: old }
  })
  await steam.getGameSchineseInfo(['1', '2', '3'])
  assert.deepEqual(batches, [['2', '3']])
  assert.equal(rows['2'].header, header)
  assert.equal(rows['3'].community, 'icon')
  assert.equal(await steam.getHeaderImgUrlByAppid('1'), 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1/hash/header.jpg')
  assert.equal(calls.length, 0)
})

test('failed metadata refresh retains cached URLs and allows CDN download', async () => {
  const { steam, rows, calls, writes } = await fixture({
    1: { appid: '1', name: 'Old', header, updatedAt: old }
  }, { batch: async () => { throw Error('timeout') } })
  assert.equal(await steam.getHeaderImageByAppid('1'), image)
  assert.equal(rows['1'].updatedAt, old)
  assert.equal(calls.length, 0)
  assert.equal(writes.length, 0)
})

test('HTML bodies and missing games get short negative caching, not successful URL caching', async () => {
  for (const details of [async () => ({}), async () => { throw Error('429') }, async () => ({ name: 'Demo', header_image: header })]) {
    const { steam, calls, downloads, rows } = await fixture({}, {
      download: async () => Buffer.from('<html>404 Not Found</html>'), details
    })
    assert.equal(await steam.getHeaderImageByAppid('4733380'), '')
    const attempts = downloads.length
    assert.equal(await steam.getHeaderImageByAppid('4733380'), '')
    assert.equal(calls.length, 1)
    assert.equal(downloads.length, attempts)
    assert.equal(rows['4733380'].header, 'header.jpg')
  }
})

test('concurrent requests for the same App share download and fallback', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { steam, calls, downloads } = await fixture({}, { download: async url => {
    await gate
    if (url !== header) throw Error('404')
    return png
  } })
  const pending = [steam.getHeaderImageByAppid('4733380'), steam.getHeaderImageByAppid(4733380)]
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(downloads.length, 1)
  release()
  assert.deepEqual(await Promise.all(pending), [image, image])
  assert.equal(calls.length, 1)
})

test('different cover downloads run concurrently with a bounded maximum', async () => {
  let active = 0, peak = 0
  const { steam } = await fixture({}, { download: async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setImmediate(resolve))
    active--
    return png
  } })
  const ids = ['1', '2', '3', '4', '5', '6']
  const info = await steam.getGameSchineseInfo(ids)
  await Promise.all(ids.map(id => steam.getHeaderImageByAppid(id, info[id])))
  assert.equal(peak, 3)
})

test('invalid App IDs do not make network requests', async () => {
  const { steam, calls, batches, downloads } = await fixture()
  for (const id of [undefined, '', 'abc', '17579876560805036032']) assert.equal(await steam.getHeaderImageByAppid(id), '')
  assert.equal(calls.length + batches.length + downloads.length, 0)
})

test('appdetails checks success and retains existing store request parameters', async () => {
  let response = { 1: { success: true, data: { header_image: header } } }
  let request
  const store = await load('models/api/store.js', {
    '#models': { utils: { request: { get: async (...args) => { request = args; return response } } } },
    '#components': { Config: { steam: { storeProxy: 'https://proxy.test/' } } },
    moment: { default: moment }
  })
  assert.equal((await store.appdetails('1')).header_image, header)
  assert.deepEqual(request, ['api/appdetails', { baseURL: 'https://proxy.test', params: { appids: '1' } }])
  response = { 1: { success: false, data: { header_image: header } } }
  assert.deepEqual(await store.appdetails('1'), {})
})

test('render resolves only visible missing covers and passes URLs to status/review templates', async () => {
  const lookups = [], screenshots = []
  const Render = (await load('components/Render.js', {
    fs: { default: {} }, lodash: { default: {} }, path,
    '#lib': { logger: {}, puppeteer: { screenshot: async (name, data) => { screenshots.push(data); return 'image' } } },
    'art-template': { default: {} },
    '#models': { canvas: {}, info: {}, utils: { steam: {
      getGameSchineseInfo: async ids => { lookups.push(ids); return { 1: { name: 'Demo', header }, 2: { header: 'header.jpg' } } },
      getHeaderImageByAppid: async id => id && id !== '2' ? image : ''
    } } },
    '#components': { Version: { pluginPath: '/steam', pluginName: 'steam-plugin' }, Config: { other: { hiddenLength: 4, itemLength: 2 }, tips: {} } }
  })).default
  const games = [{ appid: '1' }, { appid: '2' }, { appid: '3', image: 'https://existing.test/image.jpg' }, { appid: '4', noImg: true }, { appid: '5' }]
  await Render.render('inventory/index', { data: [{ games }] })
  assert.deepEqual(lookups, [['1', '2']])
  assert.equal(screenshots[0].data[0].games[0].image, image)
  assert.equal(screenshots[0].data[0].games[1].image, '')
  assert.equal(screenshots[0].data[0].games[2].image, 'https://existing.test/image.jpg')
  await Render.render('info/index', { gameId: '4733380' })
  assert.equal(screenshots[1].gameHeader, image)
  await Render.render('review/index', { appid: '4733380' })
  assert.equal(screenshots[2].header, image)
})


test('text status keeps the game name and never emits an empty image segment', async () => {
  class App {
    static getReg () { return /./ }
    constructor (info, rules) { this.rules = rules }
    create () { return this.rules }
  }
  let cover = ''
  const clock = { unix: () => ({ format: () => 'date' }) }
  const { app } = await load('apps/info.js', {
    moment: { default: clock },
    '#lib': { segment: { image: file => { assert.ok(file); return { type: 'image', file } } } },
    '#models': { api: { ISteamUser: { GetPlayerSummaries: async () => [{ communityvisibilitystate: 3, steamid: '1', gameid: '4733380', gameextrainfo: 'FlowTrak Demo' }] } }, utils: { steam: { getHeaderImageByAppid: async () => cover, headerImageFile: source => source, getFriendCode: () => '1', getPersonaState: () => '在线' } } },
    '#components': { App, Config: { other: { infoMode: 1, steamAvatar: false } }, Render: {} }
  })
  const withoutImage = await app.info.fnc({}, { steamId: '1' })
  assert.ok(withoutImage.some(item => typeof item === 'string' && item.includes('FlowTrak Demo')))
  assert.equal(withoutImage.some(item => item?.type === 'image'), false)
  cover = header
  const withImage = await app.info.fnc({}, { steamId: '1' })
  assert.equal(withImage.find(item => item?.type === 'image').file, header)
})


test('SQLite refresh advances updatedAt even when name and header are unchanged', async () => {
  const { Sequelize, DataTypes, Op } = await import('sequelize')
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
  try {
    const game = await load('models/db/game.js', {
      lodash: { default: {} }, './base.js': { sequelize, DataTypes, Op }
    })
    const info = { appid: '4733380', name: 'FlowTrak Demo', header }
    await game.table.create({ ...info, updatedAt: new Date('2020-01-01') })
    const before = Date.now()
    assert.equal(await game.set(info.appid, info), true)
    const row = await game.table.findOne({ where: { appid: info.appid } })
    assert.ok(row.updatedAt.getTime() >= before)
    assert.equal(row.header, header)
    assert.equal(await game.set('999', info), false)
  } finally {
    await sequelize.close()
  }
})


test('downloaded image data can be decoded by Canvas and converted for message adapters', async () => {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const source = createCanvas(2, 2).toBuffer('image/png')
  const { steam } = await fixture({}, { download: async () => source })
  const data = await steam.getHeaderImageByAppid('570')
  const decoded = await loadImage(data)
  assert.equal(decoded.width, 2)
  assert.equal(decoded.height, 2)
  assert.deepEqual(steam.headerImageFile(data), source)
})
