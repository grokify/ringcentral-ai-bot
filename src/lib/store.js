import SubX from 'subx'
import RingCentral from 'ringcentral-js-concise'
//import { debounceTime } from 'rxjs/operators'
import * as R from 'ramda'
import { processMail } from './voicemail-reader'
import { read, write } from './database'
import resultFormatter from './analysis-formatter'
import {log} from './log'
import {subscribeInterval, expiresIn} from '../common/constants'

const botEventFilters = () => [
  '/restapi/v1.0/glip/posts',
  '/restapi/v1.0/glip/groups',
  subscribeInterval()
]

const userEventFilters = () => [
  '/restapi/v1.0/account/~/extension/~/message-store',
  subscribeInterval()
]

// Store
const Store = new SubX({
  lastInitTime: 0,
  bots: {},
  users: {},
  caches: {},
  getBot (id) {
    return this.bots[id]
  },
  getUser (id) {
    return this.users[id]
  },
  addBot (bot) {
    this.bots[bot.token.owner_id] = bot
  },
  addUser (user) {
    this.users[user.token.owner_id] = user
  }
})


// load data from database
export const getStore = async () => {

  // load database from S3
  const database = await read()
  let store = new Store(database)
  let throttle = 30 * 60 * 1000

  // init bots
  for (const k of R.keys(store.bots)) {
    const bot = new Bot(store.bots[k])
    let now = + new Date()
    store.bots[k] = bot
    if (now - bot.lastRenewTime > throttle) {
      await bot.validate()
      await bot.renewWebHooks()
    }
  }

  // init users
  for (const k of R.keys(store.users)) {
    const user = new User(store.users[k])
    store.users[k] = user
    let now = + new Date()
    if (now - user.lastRenewTime > throttle) {
      await user.refresh()
      await user.renewWebHooks()
    }
  }

  // auto save to database
  SubX.autoRun(store, async () => {
    await write(store)
  })

  return store
}

// Bot
export const Bot = new SubX({
  lastRenewTime: 0,
  get rc () {
    const rc = new RingCentral(
      process.env.RINGCENTRAL_BOT_CLIENT_ID,
      process.env.RINGCENTRAL_BOT_CLIENT_SECRET,
      process.env.RINGCENTRAL_SERVER
    )
    rc.token(this.token)
    return rc
  },
  async authorize (code) {
    try {
      await this.rc.authorize({ code, redirectUri: process.env.RINGCENTRAL_BOT_SERVER + '/bot-oauth' })
    } catch (e) {
      log('Bot authorize', e.response.data)
    }
    this.token = this.rc.token()
  },
  async setupWebHook () {
    try {
      await this.rc.post('/restapi/v1.0/subscription', {
        eventFilters: botEventFilters(),
        expiresIn: expiresIn(),
        deliveryMode: {
          transportType: 'WebHook',
          address: process.env.RINGCENTRAL_BOT_SERVER + '/bot-webhook'
        }
      })
    } catch (e) {
      log('Bot setupWebHook error', e.response.data)
    }
  },
  async renewWebHooks () {
    try {
      const r = await this.rc.get('/restapi/v1.0/subscription')
      let filtered = r.data.records.filter(
        r => {
          return r.deliveryMode.address === process.env.RINGCENTRAL_BOT_SERVER + '/bot-webhook'
        }
      )
      log('bot subs list', filtered.map(g => g.id).join(','))
      await this.setupWebHook()
      for (let sub of filtered) {
        await this.delSubscription(sub.id)
      }
      this.lastRenewTime = + new Date()
    } catch (e) {
      log('bot renewWebHooks error', e.response.data)
    }
  },
  async delSubscription (id) {
    log('del bot sub id:', id)
    try {
      await this.rc.delete(`/restapi/v1.0/subscription/${id}`)
    } catch (e) {
      log('bot delSubscription error', e.response.data)
    }
  },
  async renewSubscription (id) {
    try {
      await this.setupWebHook()
      await this.delSubscription(id)
      log('bot renewed subscribe')
    } catch (e) {
      log('bot renewSubscription error', e.response.data)
    }
  },
  async sendMessage (groupId, messageObj) {
    try {
      await this.rc.post(`/restapi/v1.0/glip/groups/${groupId}/posts`, messageObj)
    } catch (e) {
      log('Bot sendMessage error', e.response.data)
    }
  },
  async validate () {
    try {
      await this.rc.get('/restapi/v1.0/account/~/extension/~')
      return true
    } catch (e) {
      log('Bot validate', e.response.data)
      const errorCode = e.response.data.errorCode
      if (errorCode === 'OAU-232' || errorCode === 'CMN-405') {
        let store = await getStore()
        delete store.bots[this.token.owner_id]
        log(`Bot user ${this.token.owner_id} has been deleted`)
        return false
      }
    }
  }
})

// User
export const User = new SubX({
  lastRenewTime: 0,
  groups: {},
  get rc () {
    const rc = new RingCentral(
      process.env.RINGCENTRAL_USER_CLIENT_ID,
      process.env.RINGCENTRAL_USER_CLIENT_SECRET,
      process.env.RINGCENTRAL_SERVER
    )
    rc.token(this.token)
    return rc
  },
  authorizeUri (groupId, botId) {
    return this.rc.authorizeUri(process.env.RINGCENTRAL_BOT_SERVER + '/user-oauth', {
      state: groupId + ':' + botId,
      responseType: 'code'
    })
  },
  async authorize (code) {
    try {
      await this.rc.authorize({ code, redirectUri: process.env.RINGCENTRAL_BOT_SERVER + '/user-oauth' })
    } catch (e) {
      log('User authorize error', e.response.data)
    }
    this.token = this.rc.token()
  },
  async refresh () {
    try {
      await this.rc.refresh()
      this.token = this.rc.token()
      this.lastRenewTime = + new Date()
    } catch(e) {
      log('User try refresh token', e.response.data)
      let store = await getStore()
      delete store.users[this.token.owner_id]
      log(`User ${this.token.owner_id} refresh token has expired`)
    }
  },
  async validate () {
    try {
      await this.rc.get('/restapi/v1.0/account/~/extension/~')
      return true
    } catch (e) {
      log('User validate', e.response.data)
      try {
        await this.rc.refresh()
        this.token = this.rc.token()
        return true
      } catch (e) {
        log(
          'User validate refresh',
          e.response
            ? e.response.data
            : e
        )
        let store = await getStore()
        delete store.users[this.token.owner_id]
        log(`User ${this.token.owner_id} refresh token has expired`)
        return false
      }
    }
  },
  async renewWebHooks () {
    try {
      const r = await this.rc.get('/restapi/v1.0/subscription')
      let filtered = r.data.records.filter(
        r => {
          return r.deliveryMode.address === process.env.RINGCENTRAL_BOT_SERVER + '/user-webhook'
        }
      )
      log('user subs list', filtered.map(g => g.id).join(','))
      await this.setupWebHook()
      for (let sub of filtered) {
        await this.delSubscription(sub.id)
      }
      this.lastRenewTime = + new Date()
    } catch (e) {
      log('user renewWebHooks error', e.response.data)
    }
  },
  async delSubscription (id) {
    log('del user sub id:', id)
    try {
      await this.rc.delete(`/restapi/v1.0/subscription/${id}`)
    } catch (e) {
      log('user delSubscription error', e.response.data)
    }
  },
  async renewSubscription (id) {
    try {
      await this.setupWebHook()
      await this.delSubscription(id)
      log('renewed user subscribe')
    } catch (e) {
      log('user renewSubscription', e.response.data)
    }
  },
  async setupWebHook () { // setup WebHook for voicemail
    try {
      await this.rc.post('/restapi/v1.0/subscription', {
        eventFilters: userEventFilters(),
        expiresIn: expiresIn(),
        deliveryMode: {
          transportType: 'WebHook',
          address: process.env.RINGCENTRAL_BOT_SERVER + '/user-webhook'
        }
      })
    } catch (e) {
      log('User setupWebHook error', e.response.data)
    }
  },
  async addGroup (groupId, botId) {
    const hasNoGroup = Object.keys(this.groups).length === 0
    this.groups[groupId] = botId
    if (hasNoGroup) {
      await this.setupWebHook()
    }
  },
  async getVoiceMails (count) {
    const r = await this.rc.get('/restapi/v1.0/account/~/extension/~/message-store', {
      params: {
        messageType: 'VoiceMail',
        perPage: count
      }
    })
    return r.data.records
  },
  async syncVoiceMails (params = {
    recordCount: 10,
    syncType: 'FSync'
  }) {
    const r = await this.rc.get('/restapi/v1.0/account/~/extension/~/message-sync', {
      params: {
        ...params,
        messageType: 'VoiceMail'
      }
    })
    return r.data.records
  },
  async processVoiceMail (newMailCount = 10) {
    let voiceMails = await this.getVoiceMails(newMailCount)
    let userId = this.token.owner_id
    for (let mail of voiceMails) {
      let msg = await processMail(mail, this.rc)
      await this.sendVoiceMailInfo(
        resultFormatter(userId, msg || {})
      )
    }
  },
  async sendVoiceMailInfo (processedMailInfo = '') {
    for (const groupId of Object.keys(this.groups)) {
      const botId = this.groups[groupId]
      let store = await getStore()
      const bot = store.getBot(botId)
      await bot.sendMessage(
        groupId,
        { text: processedMailInfo }
      )
    }
  }
})

getStore()
