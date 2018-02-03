const path = require('path')
const fs = require('fs')
const os = require('os')
const yn = require('yn')
const tmp = require('tmp')
tmp.setGracefulCleanup() // delete tmp files even on uncaught exception

const _ = require('lodash')
const co = require('co')
const promisify = require('pify')
const promptly = require('promptly')
const pfs = promisify(fs)
const AWS = require('aws-sdk')
const shelljs = require('shelljs')
const mkdirp = promisify(require('mkdirp'))
const ModelsPack = require('@tradle/models-pack')
const CustomErrors = require('./errors')
const validate = require('./validate')
const utils = require('./utils')
const { debug, prettify, isValidProjectPath, toEnvFile, promptToConfirm } = utils
const AWS_CONF_PATH = `${os.homedir()}/.aws/config`
const getFileNameForItem = item => `${item.id}.json`
const read = file => fs.readFileSync(file, { encoding: 'utf8' })
const maybeRead = file => {
  if (fs.existsSync(file)) return read(file)
}

const readJSON = file => JSON.parse(read(file))
const maybeReadJSON = file => {
  const result = maybeRead(file)
  if (result) return JSON.parse(result)
}

const write = (file, data) => fs.writeFileSync(file, prettify(data))
const pwrite = (file, data) => pfs.writeFile(file, prettify(data))
const exists = file => fs.existsSync(file)
const getLongFunctionName = ({ stackName, functionName }) => `${stackName}-${functionName}`
const readDirOfJSONs = dir => {
  return fs.readdirSync(dir)
    .map(file => require(path.resolve(dir, file)))
}

const getOptsOnly = opts => _.omit(opts, 'args')

const functions = {
  setconf: 'setconf',
  cli: 'cli',
  importDataUtils: 'import_data_utils'
}

const paths = {
  conf: './conf',
  bot: './conf/bot.json',
  style: './conf/style.json',
  terms: './conf/terms-and-conditions.md',
  models: './models',
  lenses: './lenses'
}

read.bot = () => maybeReadJSON(paths.bot)
read.style = () => maybeReadJSON(paths.style)
read.models = () => readDirOfJSONs(paths.models)
read.lenses = () => readDirOfJSONs(paths.lenses)
read.terms = () => maybeRead(paths.terms)

const initSchema = {
  properties: {
    profile: {
      description: 'your AWS profile',
    },
    stackName: {
      description: 'your Tradle stack name'
    }
  }
}

function Conf (opts) {
  if (!(this instanceof Conf)) {
    return new Conf(opts)
  }

  const { lambda, stackName, local, project, nodeFlags={} } = opts
  if (!lambda) {
    throw new Error('expected "lambda"')
  }

  this.stackName = stackName
  this.lambda = lambda
  this.local = local
  this.project = project
  if (local) {
    if (!project) {
      throw new Error('expected "project", the path to your local serverless project')
    }

    if (!isValidProjectPath(project)) {
      throw new Error('expected "project" to point to serverless project dir')
    }
  }

  if (!nodeFlags.inspect && (nodeFlags.debug || nodeFlags['debug-brk'])) {
    nodeFlags.inspect = true
  }

  this.nodeFlags = nodeFlags
}

Conf.prototype._ensureStackName = function () {
  if (!this.stackName) {
    throw new Error('expected "stackName"')
  }
}

Conf.prototype.deploy = co.wrap(function* (opts) {
  const { error, result } = yield this.invoke({
    functionName: functions.setconf,
    arg: this.getDeployItems(opts)
  })

  if (error) throw error
})

Conf.prototype.invoke = co.wrap(function* (opts) {
  const { functionName, arg, local=this.local } = opts
  let result
  try {
    const promise = local ? this._invokeLocal(opts) : this._invoke(opts)
    result = yield promise
  } catch (error) {
    return { error }
  }

  return { result }
})

Conf.prototype.invokeAndReturn = co.wrap(function* (opts) {
  const { error, result } = yield this.invoke(opts)
  if (error) throw error
  return result
})

Conf.prototype._invoke = co.wrap(function* ({ functionName, arg }) {
  if (!(yield promptToConfirm(`You're about to execute an operation on your REMOTE deployment`))) {
    throw new CustomErrors.UserAborted()
  }

  const {
    StatusCode,
    Payload,
    FunctionError
  } = yield this.lambda.invoke({
    InvocationType: 'RequestResponse',
    FunctionName: this.getLongFunctionName(functionName),
    Payload: JSON.stringify(arg)
  }).promise()

  if (FunctionError || StatusCode >= 300) {
    const message = Payload || FunctionError
    throw new Error(message.toString())
  }

  return JSON.parse(Payload)
})

Conf.prototype.getLongFunctionName = function (functionName) {
  return getLongFunctionName({
    stackName: this.stackName,
    functionName
  })
}

Conf.prototype.getDeployItems = function getDeployItems (opts) {
  const all = !_.size(getOptsOnly(opts))
  const parts = {}
  if (all || opts.style) {
    parts.style = read.style()
  }

  if (all || opts.terms) {
    parts.terms = read.terms()
  }

  if (all || opts.models) {
    parts.modelsPack = utils.pack({
      models: read.models(),
      lenses: read.lenses()
    })
  }

  if (all || opts.bot) {
    parts.bot = read.bot()
  }

  if (!_.size(parts)) {
    throw new Error('you didn\'t indicate anything to deploy!')
  }

  return parts
}

Conf.prototype._invokeLocal = co.wrap(function* ({ functionName, arg }) {
  const { project, nodeFlags } = this
  const flagsStr = Object.keys(nodeFlags)
    .filter(key => nodeFlags[key])
    .map(key => `--${key}="${nodeFlags[key]}"`)
    .join(' ')

  if (typeof arg !== 'string') arg = JSON.stringify(arg)

  const tmpInput = tmp.fileSync({ postfix: '.json' })
  const tmpOutput = tmp.fileSync({ postfix: '.json' })
  write(tmpInput.name, JSON.stringify(arg))

  const slsPath = path.join(project, 'node_modules/.bin/sls')
  const command =`IS_OFFLINE=1 node ${flagsStr} \
${slsPath} invoke local \
-f "${functionName}" \
-l false \
--path "${tmpInput.name}" \
--output "${tmpOutput.name}"`

  debug(`running command: ${command}`)
  const result = shelljs.exec(command, { silent: true })
  const res = read(tmpOutput.name).trim()
  if (result.code !== 0) throw new Error(res || 'invoke failed')

  return res && JSON.parse(res)
})

Conf.prototype.load = co.wrap(function* (opts={}) {
  const res = yield this.invoke({
    functionName: functions.cli,
    arg: 'getconf --conf'
  })

  const { error, result } = res
  if (error) throw error

  if (opts.style && result.style) {
    debug('loaded remote style')
    write(paths.style, result.style)
  }

  if (opts.bot && result.bot) {
    debug('loaded remote bot conf')
    write(paths.bot, result.bot)
  }

  if (opts.terms && result.terms) {
    debug('loaded remote terms and conditions')
    write(paths.terms, result.terms)
  }

  if (opts.models && result.modelsPack) {
    debug('loaded remote models and lenses')
    this.writeModels(result.modelsPack)
  }
})

Conf.prototype.writeModels = co.wrap(function* (modelsPack) {
  yield ['models', 'lenses'].map(co.wrap(function* (prop) {
    const arr = modelsPack[prop]
    if (!arr) return

    yield this.writeToFiles({
      dir: paths[prop],
      arr,
      name: getFileNameForItem
    })
  }).bind(this))
})

Conf.prototype.writeToFiles = co.wrap(function* ({ dir, name, arr }) {
  yield mkdirp(dir)
  yield Promise.all(arr.map(item => {
    return pwrite(path.join(dir, name(item)), item)
  }))
})

Conf.prototype.validate = co.wrap(function* (opts) {
  const items = this.getDeployItems(opts)
  _.each(items, (value, key) => {
    if (typeof value !== 'undefined') {
      debug(`validating: ${key}`)
      validate[key](value)
    }
  })
})

Conf.prototype.exec = co.wrap(function* (opts) {
  return yield this.invoke({
    functionName: functions.cli,
    arg: opts.args[0]
  })
})

Conf.prototype.init = co.wrap(function* () {
  if (exists('./.env')) {
    if (!(yield promptToConfirm('This will overwrite your .env file'))) {
      return
    }
  }

  const awsConf = maybeRead(AWS_CONF_PATH)
  if (awsConf) {
    console.log('See below your profiles from your ~/.aws/config:\n')
    console.log(awsConf)
  }

  const awsProfile = yield promptly.prompt('Which AWS profile will you be using?')
  const stackNames = yield this.getStacks(awsProfile)
  let stackName
  do {
    console.log('These are the stacks you have in AWS:\n')
    console.log(stackNames.join('\n'))
    console.log('\n')

    stackName = yield promptly.prompt('Which one is your Tradle stack?')
    if (stackNames.includes(stackName)) {
      break
    }

    console.log(`You don't have a stack called "${stackName}"!`)
  } while (true)

  const haveLocal = yield promptly.prompt('Do you have a local development environment, a clone of https://github.com/tradle/serverless? (y/n)')
  let projectPath
  if (yn(haveLocal)) {
    do {
      let resp = yield promptly.prompt('Please provide the path to your project directory, or type "s" to skip')
      if (resp.replace(/["']/g).toLowerCase() === 's') break

      if (isValidProjectPath(resp)) {
        projectPath = path.resolve(resp)
        break
      }

      console.log('Provided path doesn\'t contain a serverless.yml')
    } while (true)
  }

  const env = {
    awsProfile,
    stackName
  }

  if (projectPath) env.project = projectPath

  write('.env', toEnvFile(env))

  console.log('wrote .env')
  yield [paths.models, paths.lenses, paths.conf].map(dir => mkdirp(dir))
  console.log('initialization complete!')
  // console.log('Would you like to load your currently deployed configuration?')
  // const willLoad = yield promptly.prompt('Note: this may overwrite your local files in ./conf, ./models and ./lenses (y/n)')
  // if (!yn(willLoad)) return
})

Conf.prototype.getStacks = co.wrap(function* (profile) {
  if (profile) {
    AWS.config.credentials = new AWS.SharedIniFileCredentials({ profile })
  }

  const cloudformation = new AWS.CloudFormation()
  if (profile) {
    cloudformation.config.profile = profile
  }

  const listStacksOpts = {
    StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE']
  }

  let stackNames = []
  let keepGoing = true
  while (keepGoing) {
    let {
      NextToken,
      StackSummaries
    } = yield cloudformation.listStacks(listStacksOpts).promise()

    stackNames = stackNames.concat(StackSummaries.map(({ StackName }) => StackName))
    listStacksOpts.NextToken = NextToken
    keepGoing = !!NextToken
  }

  return stackNames
})

const createImportDataUtilsMethod = ({
  method,
  props=[],
  required
}) => co.wrap(function* (data) {
  data = _.pick(data, props)
  ;(required || props).forEach(prop => {
    if (!(prop in data)) throw new Error(`expected "${prop}"`)
  })

  return yield this.invokeAndReturn({
    functionName: functions.importDataUtils,
    arg: { method, data }
  })
})

Conf.prototype.createDataBundle = co.wrap(function* ({ path }) {
  let bundle
  try {
    bundle = readJSON(path)
  } catch (err) {
    throw new Error('expected "path" to bundle')
  }

  return yield this.invokeAndReturn({
    functionName: functions.importDataUtils,
    arg: {
      method: 'createbundle',
      data: bundle
    }
  })
})

Conf.prototype.createDataClaim = createImportDataUtilsMethod({
  method: 'createclaim',
  props: ['key']
})

Conf.prototype.listDataClaims = createImportDataUtilsMethod({
  method: 'listclaims',
  props: ['key']
})

Conf.prototype.getDataBundle = createImportDataUtilsMethod({
  method: 'getbundle',
  props: ['key', 'claimId'],
  required: []
})

exports = module.exports = Conf
