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

async function fixture (initial = {}, fetch = async () => ({ name: 'FlowTrak Demo', header_image: header })) {
  const rows = structuredClone(initial), calls = [], writes = []
  const db = { game: {
    get: async ids => Object.fromEntries(ids.filter(id => rows[id]).map(id => [id, { ...rows[id] }])),
    add: async games => { for (const game of games) { writes.push(game); rows[game.appid] = { ...game, updatedAt: fresh } } },
    set: async (id, game) => { writes.push(game); rows[id] = { ...rows[id], ...game, updatedAt: fresh } }
  } }
  const api = { store: { appdetails: async id => { calls.push(id); return fetch(id) } } }
  const steam = await load('models/utils/steam.js', {
    lodash: { default: lodash }, moment: { default: moment },
    '#models': { api, db }, '#components': { Config: {} }, crypto: { randomBytes: () => {} }
  })
  return { steam, rows, calls, writes }
}

test('stores and reuses the complete API URL including hash and query', async () => {
  const { steam, rows, calls } = await fixture()
  assert.equal(await steam.getHeaderImgUrlByAppid(4733380), header)
  assert.equal(rows['4733380'].name, 'FlowTrak Demo')
  assert.equal(rows['4733380'].header, header)
  assert.equal(await steam.getHeaderImgUrlByAppid('4733380'), header)
  assert.deepEqual(calls, ['4733380'])
})

test('refreshes only expired or legacy relative-path records and preserves other fields', async () => {
  const { steam, rows, calls } = await fixture({
    1: { appid: '1', name: 'Fresh', header, updatedAt: fresh },
    2: { appid: '2', name: 'Old', header, updatedAt: old },
    3: { appid: '3', name: 'Legacy', header: 'hash/header.jpg', community: 'icon', updatedAt: fresh }
  })
  await steam.getGameSchineseInfo(['1', '2', '3', 3])
  assert.deepEqual(calls, ['2', '3'])
  assert.equal(rows['3'].header, header)
  assert.equal(rows['3'].community, 'icon')
})

test('failed refresh preserves stale data and does not extend its expiry', async () => {
  const { steam, rows, writes } = await fixture({
    1: { appid: '1', name: 'Old', header, updatedAt: old },
    2: { appid: '2', name: 'Legacy', header: 'header.jpg', updatedAt: old }
  }, async () => { throw Error('timeout') })
  assert.equal(await steam.getHeaderImgUrlByAppid('1'), header)
  assert.equal(await steam.getHeaderImgUrlByAppid('2'), '')
  assert.equal(await steam.getHeaderImgUrlByAppid('3'), '')
  assert.equal(rows['1'].updatedAt, old)
  assert.equal(writes.length, 0)
})

test('missing or invalid image is omitted while the name remains cached', async () => {
  for (const image of [undefined, '', 'header.jpg', 'javascript:alert(1)']) {
    const { steam, rows, calls } = await fixture({}, async () => ({ name: 'Demo', header_image: image }))
    assert.equal(await steam.getHeaderImgUrlByAppid('1'), '')
    assert.equal(rows['1'].name, 'Demo')
    await steam.getHeaderImgUrlByAppid('1')
    assert.equal(calls.length, 1)
  }
})

test('an unavailable app is not persisted and does not block other games', async () => {
  const { steam, rows } = await fixture({}, async id => id === '1' ? {} : ({ name: 'Demo', header_image: header }))
  const info = await steam.getGameSchineseInfo(['1', '2'])
  assert.equal(rows['1'], undefined)
  assert.equal(info['2'].header, header)
})

test('overlapping requests share a refresh and invalid/non-Steam IDs are ignored', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { steam, calls, writes } = await fixture({}, async () => { await gate; return { name: 'Demo', header_image: header } })
  const first = steam.getHeaderImgUrlByAppid('4733380')
  const second = steam.getHeaderImgUrlByAppid(4733380)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1)
  release()
  assert.deepEqual(await Promise.all([first, second]), [header, header])
  assert.equal(writes.length, 1)
  for (const id of [undefined, '', '17579876560805036032', 'abc']) assert.equal(await steam.getHeaderImgUrlByAppid(id), '')
  assert.equal(calls.length, 1)
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
      getHeaderImgUrlByAppid: async id => id ? header : ''
    } } },
    '#components': { Version: { pluginPath: '/steam', pluginName: 'steam-plugin' }, Config: { other: { hiddenLength: 4, itemLength: 2 }, tips: {} } }
  })).default
  const games = [{ appid: '1' }, { appid: '2' }, { appid: '3', image: 'https://existing.test/image.jpg' }, { appid: '4', noImg: true }, { appid: '5' }]
  await Render.render('inventory/index', { data: [{ games }] })
  assert.deepEqual(lookups, [['1', '2']])
  assert.equal(screenshots[0].data[0].games[0].image, header)
  assert.equal(screenshots[0].data[0].games[1].image, '')
  assert.equal(screenshots[0].data[0].games[2].image, 'https://existing.test/image.jpg')
  await Render.render('info/index', { gameId: '4733380' })
  assert.equal(screenshots[1].gameHeader, header)
  await Render.render('review/index', { appid: '4733380' })
  assert.equal(screenshots[2].header, header)
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
    '#models': { api: { ISteamUser: { GetPlayerSummaries: async () => [{ communityvisibilitystate: 3, steamid: '1', gameid: '4733380', gameextrainfo: 'FlowTrak Demo' }] } }, utils: { steam: { getHeaderImgUrlByAppid: async () => cover, getFriendCode: () => '1', getPersonaState: () => '在线' } } },
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
