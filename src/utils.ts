import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import _ from 'lodash'
import co from 'co'
import yn from 'yn'
import promisify from 'pify'
import promptly from 'promptly'
import chalk from 'chalk'
import shelljs from 'shelljs'
import fetch from 'node-fetch'
import AWS from 'aws-sdk'
import YAML from 'js-yaml'
import ModelsPack from '@tradle/models-pack'
import Errors from '@tradle/errors'
import { emptyBucket } from './empty-bucket'
import { logger, colors } from './logger'
import { Errors as CustomErrors } from './errors'
import { confirm } from './prompts'
import { ConfOpts, CloudResource, CloudResourceType, } from './types'
import { REMOTE_ONLY_COMMANDS, SAFE_REMOTE_COMMANDS } from './constants'

interface CreateStackOpts {
  cloudformation: AWS.CloudFormation
  params: AWS.CloudFormation.CreateStackInput
}

interface UpdateStackOpts {
  cloudformation: AWS.CloudFormation
  params: AWS.CloudFormation.UpdateStackInput
}

interface DeleteStackOpts {
  cloudformation: AWS.CloudFormation
  params: AWS.CloudFormation.DeleteStackInput
}

interface UpdateStackInRegionOpts {
  region: string
  params: AWS.CloudFormation.UpdateStackInput
}

interface CreateStackInRegionOpts {
  region: string
  params: AWS.CloudFormation.CreateStackInput
}

export const MY_CLOUD_STACK_NAME_REGEX = /^tdl-(.*?)-ltd-([a-zA-Z]+)$/

export const get = async (url) => {
  const res = await fetch(url)
  if (res.statusCode > 300) {
    throw new Error(res.statusText)
  }

  return await res.json()
}

export const getNamespace = ({ models, lenses }) => {
  const model = _.values(models)[0] || _.values(lenses)[0]
  return model && ModelsPack.getNamespace(model.id)
}

export const pack = ({ namespace, models, lenses }: {
  namespace?: string
  models?: any
  lenses?: any
}) => {
  if (!(_.size(models) || _.size(lenses))) {
    throw new CustomErrors.InvalidInput('expected "models" and/or "lenses"')
  }

  if (!namespace) {
    namespace = getNamespace({ models, lenses })
  }

  const modelsPack = ModelsPack.pack({ namespace, models, lenses })
  return modelsPack
}

export const prettify = obj => {
  return typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
}

export const isValidProjectPath = project => {
  return fs.existsSync(path.resolve(project, 'serverless.yml'))
}

export const toEnvFile = obj => Object.keys(obj)
  .map(key => `${key}="${obj[key]}"`)
  .join('\n')

type StackResourceSummaryFilter = (item: AWS.CloudFormation.StackResourceSummary) => boolean

const acceptAll = (item: any) => true

const isRetained = ({ DeletionPolicy }) => DeletionPolicy === 'Retain'
const getRetainedResources = (template: any) => Object.keys(template.Resources)
  .filter(logicalId => isRetained(template.Resources[logicalId]))

export const getStackTemplates = async (cloudformation: AWS.CloudFormation, stackId: string) => {
  const main = await getStackTemplate({ cloudformation, stackId })
  const nested = await listSubstacks(cloudformation, stackId)
  if (!nested.length) return [main]

  const nestedTemplates = _.flatten(await Promise.all(nested.map(n => getStackTemplates(cloudformation, n.PhysicalResourceId))))
  return [main].concat(nestedTemplates)
}

export const getStackInfo = async ({ cloudformation, stackId }: {
  cloudformation: AWS.CloudFormation
  stackId: string
}):Promise<AWS.CloudFormation.Stack> => {
  const {
    Stacks,
  } = await cloudformation.describeStacks({ StackName: stackId }).promise()

  return Stacks[0]
}

export const getStackOutputs = async ({ cloudformation, stackId }: {
  cloudformation: AWS.CloudFormation
  stackId: string
}):Promise<AWS.CloudFormation.Output[]> => {
  const { Outputs } = await getStackInfo({ cloudformation, stackId })
  return Outputs
}

export const getStackParameters = async ({ cloudformation, stackId }: {
  cloudformation: AWS.CloudFormation
  stackId: string
}):Promise<AWS.CloudFormation.Parameter[]> => {
  const { Parameters } = await getStackInfo({ cloudformation, stackId })
  return Parameters
}

export const listOutputResources = async ({ cloudformation, stackId }: {
  cloudformation: AWS.CloudFormation
  stackId: string
}):Promise<CloudResource[]> => {
  const outputs = await getStackOutputs({ cloudformation, stackId })
  return outputs.map(({ OutputKey, OutputValue }) => {
    const match = OutputKey.match(/(Bucket|Table|Key)$/)
    if (match) {
      const type = match[1].toLowerCase() as CloudResourceType
      return { type, name: OutputKey, value: OutputValue }
    }
  })
  .filter(_.identity)
}

// export const listRetainedResources = async (cloudformation: AWS.CloudFormation, stackName):Promise<AWS.CloudFormation.StackResourceSummary[]> => {
//   const [template, resources] = await Promise.all([
//     getStackTemplate(cloudformation, stackName),
//     listStackResources(cloudformation, stackName),
//   ])

//   const retained = Object.keys(template.Resources)
//     .filter(logicalId => isRetained(template.Resources[logicalId]))
//     .map(logicalId => resources.find(r => r.LogicalResourceId === logicalId))
//     // some resources may be created conditionally (created or passed in parameters)
//     .filter(_.identity)

//   const nestedStacks = resources.filter(r => r.ResourceType === 'AWS::CloudFormation::Stack')
//   const nestedRetained = _.flatten(
//     await Promise.all(nestedStacks.map(r => listRetainedResources(cloudformation, r.PhysicalResourceId)))
//   )

//   return retained.concat(nestedRetained)
// }

export const listStackResources = async (
  cloudformation: AWS.CloudFormation,
  StackName: string,
  filter: StackResourceSummaryFilter=acceptAll
):Promise<AWS.CloudFormation.StackResourceSummary[]> => {
  let resources:AWS.CloudFormation.StackResourceSummary[] = []
  const opts:AWS.CloudFormation.ListStackResourcesInput = { StackName }
  while (true) {
    let {
      StackResourceSummaries,
      NextToken
    } = await cloudformation.listStackResources(opts).promise()

    resources = resources.concat(StackResourceSummaries.filter(filter))
    opts.NextToken = NextToken
    if (!opts.NextToken) break
  }

  return resources
}

export const listStackResourcesByType = (type, cloudformation: AWS.CloudFormation, stackName:string) => {
  return listStackResources(cloudformation, stackName, ({ ResourceType }) => type === ResourceType)
}

export const listStackResourceIdsByType = async (type, cloudformation: AWS.CloudFormation, stackName:string) => {
  const resources = await listStackResourcesByType(type, cloudformation, stackName)
  return resources.map(r => r.PhysicalResourceId)
}

export const listStackBuckets = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourcesByType('AWS::S3::Bucket', cloudformation, stackName)

export const listStackBucketIds = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourceIdsByType('AWS::S3::Bucket', cloudformation, stackName)

export const listStackFunctions = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourcesByType('AWS::Lambda::Function', cloudformation, stackName)

export const listStackFunctionIds = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourceIdsByType('AWS::Lambda::Function', cloudformation, stackName)

export const listStackTables = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourcesByType('AWS::Dynamodb::Table', cloudformation, stackName)

export const listStackTableIds = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourceIdsByType('AWS::DynamoDB::Table', cloudformation, stackName)

export const listSubstacks = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourcesByType('AWS::CloudFormation::Stack', cloudformation, stackName)

export const listSubstackIds = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourceIdsByType('AWS::CloudFormation::Stack', cloudformation, stackName)

export const destroyBucket = async (s3: AWS.S3, Bucket: string) => {
  await emptyBucket(s3, Bucket)
  try {
    await s3.deleteBucket({ Bucket }).promise()
  } catch (err) {
    Errors.ignore(err, [
      { code: 'ResourceNotFoundException' },
      { code: 'NoSuchBucket' },
    ])
  }
}

export const markBucketForDeletion = async (s3: AWS.S3, Bucket: string) => {
  const params: AWS.S3.PutBucketLifecycleConfigurationRequest = {
    Bucket,
    LifecycleConfiguration: {
      Rules: [
        {
          Status: 'Enabled',
          ID: 'expires-in-1-day',
          Prefix: '',
          Expiration: {
            Days: 1,
          },
          NoncurrentVersionExpiration: {
            NoncurrentDays: 1
          }
        }
      ]
    }
  }

  await s3.putBucketLifecycleConfiguration(params).promise()
}

export const disableStackTerminationProtection = async (cloudformation: AWS.CloudFormation, StackName:string) => {
  return await cloudformation.updateTerminationProtection({
    StackName,
    EnableTerminationProtection: false,
  }).promise()
}

export const deleteStack = async ({ cloudformation, params }: DeleteStackOpts) => {
  while (true) {
    try {
      await cloudformation.deleteStack(params).promise()
      break
    } catch (err) {
      if (!err.message.includes('UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS')) {
        throw err
      }

      // back off, try again
      await exports.wait(5000)
    }
  }

  return async () => {
    await exports.wait(5000)
    await awaitStackDelete(cloudformation, params.StackName)
  }
}

export const createStackInRegion = async ({ region, params }: CreateStackInRegionOpts) => {
  return createStack({
    cloudformation: new AWS.CloudFormation({ region }),
    params,
  })
}

export const updateStackInRegion = async ({ region, params }: UpdateStackInRegionOpts) => {
  return updateStack({
    cloudformation: new AWS.CloudFormation({ region }),
    params,
  })
}

export const createStack = async ({ cloudformation, params }: CreateStackOpts) => {
  await cloudformation.createStack(params).promise()
  return async () => {
    await exports.wait(5000)
    await awaitStackCreate(cloudformation, params.StackName)
  }
}

export const updateStack = async ({ cloudformation, params }: UpdateStackOpts) => {
  await cloudformation.updateStack(params).promise()
  return async () => {
    await exports.wait(5000)
    await awaitStackUpdate(cloudformation, params.StackName)
  }
}

export const updateStackAndWait = (opts:UpdateStackOpts) => updateStack(opts).then(wait => wait())
export const updateStackInRegionAndWait = (opts:UpdateStackInRegionOpts) => updateStackInRegion(opts).then(wait => wait())
export const createStackAndWait = (opts:CreateStackOpts) => createStack(opts).then(wait => wait())
export const createStackInRegionAndWait = (opts:CreateStackInRegionOpts) => createStackInRegion(opts).then(wait => wait())
export const deleteStackAndWait = (opts:DeleteStackOpts) => deleteStack(opts).then(wait => wait())

const isUpdateableStatus = (status: AWS.CloudFormation.StackStatus) => {
  return status.endsWith('_COMPLETE') && !status.startsWith('DELETE_')
}

export const getStackId = async (cloudformation: AWS.CloudFormation, stackName: string):Promise<string> => {
  const stacks = await listStacks(
    cloudformation,
    ({ StackName, StackStatus }) => StackName === stackName && isUpdateableStatus(StackStatus)
  )

  return stacks[0] && stacks[0].id
}

export const getStackTemplate = async ({ cloudformation, stackId }: {
  cloudformation: AWS.CloudFormation
  stackId: string
}):Promise<any> => {
  const { TemplateBody } = await cloudformation.getTemplate({
    StackName: stackId
  }).promise()

  if (TemplateBody.trim().startsWith('{')) {
    return JSON.parse(TemplateBody)
  }

  return YAML.safeLoad(TemplateBody)
}

// export const createOrUpdateStack = async (aws: AWS, params: AWS.CloudFormation.UpdateStackInput) => {
//   const StackId = await getStackId(aws, params.StackName)
//   if (StackId) {
//     await updateStack(aws, params)
//   } else {
//     await createStack(aws, params)
//   }
// }

export const awaitStackCreate = async (cloudformation: AWS.CloudFormation, stackName:string) => {
  return waitFor({ cloudformation, event: 'stackCreateComplete', stackName })
}

export const awaitStackDelete = async (cloudformation: AWS.CloudFormation, stackName:string) => {
  return waitFor({ cloudformation, event: 'stackDeleteComplete', stackName })
}

export const awaitStackUpdate = async (cloudformation: AWS.CloudFormation, stackName:string) => {
  return waitFor({ cloudformation, event: 'stackUpdateComplete', stackName })
}

export const waitFor = async ({ cloudformation, stackName, event }: {
  cloudformation: AWS.CloudFormation
  stackName: string
  event: 'stackCreateComplete' | 'stackUpdateComplete' | 'stackDeleteComplete'
}) => {
  try {
    // @ts-ignore
    return await cloudformation.waitFor(event, { StackName: stackName }).promise()
  } catch (err) {
    const url = getConsoleLinkForStacksInRegion({ region: cloudformation.config.region, status: 'failed' })
    throw new CustomErrors.ServerError(`operation may have failed. Check your stacks here: ${url}`)
  }
}

type FilterStackSummary = (item: AWS.CloudFormation.StackSummary) => boolean

export const listStacks = async (cloudformation: AWS.CloudFormation, filter:FilterStackSummary=acceptAll) => {
  const listStacksOpts:AWS.CloudFormation.ListStacksInput = {
    StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE']
  }

  let stackInfos = []
  let keepGoing = true
  while (keepGoing) {
    let {
      NextToken,
      StackSummaries
    } = await cloudformation.listStacks(listStacksOpts).promise()

    stackInfos = stackInfos.concat(StackSummaries.filter(filter).map(({ StackId, StackName }) => ({
      id: StackId,
      name: StackName
    })))

    listStacksOpts.NextToken = NextToken
    keepGoing = !!NextToken
  }

  return stackInfos
}

// export const deleteAutoScalingTargets = async (aws: AWS, StackName: string) => {
//   let params: _AWS.ApplicationAutoScaling.DescribeScalableTargetsRequest = {
//     ServiceNamespace: 'dynamodb'
//   }

//   let targets:_AWS.ApplicationAutoScaling.ScalableTarget[] = []
//   let batch:_AWS.ApplicationAutoScaling.DescribeScalableTargetsResponse
//   do {
//     batch = await aws.applicationAutoScaling.describeScalableTargets(params).promise()
//     targets = targets.concat(batch.ScalableTargets)
//   } while (batch.NextToken)

//   const prefix = `table/${StackName}-`
//   const targetsForStack = targets.filter(target => target.ResourceId.startsWith(prefix))
//   if (!targetsForStack) return

//   await Promise.all(targetsForStack.map(async ({ ResourceId, ServiceNamespace, ScalableDimension }) => {
//     await aws.applicationAutoScaling.deregisterScalableTarget({
//       ResourceId,
//       ServiceNamespace,
//       ScalableDimension,
//     }).promise()
//   }))
// }

export const getApiBaseUrl = async (cloudformation: AWS.CloudFormation, StackName:string) => {
  const result = await cloudformation.describeStacks({ StackName }).promise()
  const { Outputs } = result.Stacks[0]
  const endpoint = Outputs.find(x => /^ServiceEndpoint/.test(x.OutputKey))
  return endpoint.OutputValue
}

export const splitCamelCase = str => str.split(/(?=[A-Z])/g)
export const checkCommandInPath = cmd => {
  const { code } = shelljs.exec(`command -v ${cmd}`)
  if (code !== 0) {
    throw new CustomErrors.InvalidEnvironment(`Please install: ${cmd}`)
  }
}

export const wait = millis => new Promise(resolve => setTimeout(resolve, millis))
export const normalizeNodeFlags = flags => {
  if (!(flags.inspect || flags['inspect-brk'] || flags.debug || flags['debug-brk'])) return

  const nodeVersion = Number(process.version.slice(1, 2))
  if (nodeVersion >= 8) {
    if (flags.debug) {
      delete flags.debug
      flags.inspect = true
    }

    if (flags['debug-brk']) {
      delete flags['debug-brk']
      flags['inspect-brk'] = true
    }
  } else {
    if (flags.debug || flags['debug-brk']) {
      flags.inspect = true
    }
  }
}

export const pickNonNull = obj => _.pickBy(obj, val => val != null)

const sha256 = (str: string, enc: crypto.HexBase64Latin1Encoding = 'hex') => {
  return crypto.createHash('sha256').update(str).digest(enc)
}

const shortenString = (str: string, maxLength: number) => {
  const tooLongBy = str.length - maxLength
  if (tooLongBy <= 0) return str

  if (str.length < 6) throw new Error(`string is too short: ${str}`)

  return str.slice(0, maxLength - 6) + sha256(str).slice(0, 6)
}

const parseMyCloudStackName = (name: string) => {
  const [shortName, stage] = name.match(MY_CLOUD_STACK_NAME_REGEX).slice(1)
  return {
    shortName,
    stage,
  }
}

export const isMyCloudStackName = (name: string) => MY_CLOUD_STACK_NAME_REGEX.test(name)
export const assertIsMyCloudStackName = (name: string) => {
  if (!isMyCloudStackName(name)) {
    throw new CustomErrors.InvalidInput(`"newStackName" must adhere to regex: ${MY_CLOUD_STACK_NAME_REGEX}`)
  }
}

export const getServicesStackName = (stackName: string) => {
  const { shortName } = parseMyCloudStackName(stackName)
  const shorterName = shortenString(shortName, 14)
  return `${shorterName}-srvcs` // max length 20 chars
}

export const canAccessECRRepos = async (ecr: AWS.ECR, { accountId, repoNames }: {
  accountId: string,
  repoNames: string[]
}) => {
  try {
    await ecr.describeRepositories({
      registryId: accountId,
      repositoryNames: repoNames
    }).promise()

    return true
  } catch (err) {
    if (err.name === 'AccessDeniedException') {
      return false
    }

    throw err
  }
}

export const doKeyPairsExist = async (ec2: AWS.EC2, names: string[]) => {
  const params: AWS.EC2.DescribeKeyPairsRequest = {
    KeyNames: names
  }

  try {
    await ec2.describeKeyPairs(params).promise()
    return true
  } catch (err) {
    return false
  }
}

export const listKeyPairs = async (ec2: AWS.EC2) => {
  const { KeyPairs } = await ec2.describeKeyPairs().promise()
  return KeyPairs.map(k => k.KeyName)
}

// export const listRegions = async (aws: AWS) => {
//   const { Regions } = await aws.ec2.describeRegions().promise()
//   return Regions.map(r => r.RegionName)
// }

export const listAZs = async ({ region }) => {
  const ec2 = new AWS.EC2({ region })
  const { AvailabilityZones } = await ec2.describeAvailabilityZones({
    Filters: [
      {
        Name: 'region-name',
        Values: [region]
      }
    ]
  }).promise()

  return AvailabilityZones
    .filter(a => a.RegionName === region)
    .map(a => a.ZoneName)
}

export const getUsedEIPCount = async (ec2: AWS.EC2) => {
  const { Addresses } = await ec2.describeAddresses().promise()
  return Addresses.length
}

export const getConsoleLinkForStacksInRegion = ({ region, status='active' }) => {
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks?filter=${status}`
}

export const updateEnvironments = async (lambda: AWS.Lambda, { functions, transform }: {
  functions: string[]
  transform: ({ name: string, env: any }) => any
}) => {
  const confs = await Promise.all(functions.map(FunctionName => lambda.getFunctionConfiguration({ FunctionName }).promise()))
  await Promise.all(functions.map(async (FunctionName, i) => {
    const conf = confs[i]
    const Variables = transform({
      name: FunctionName,
      env: conf.Environment.Variables
    })

    await lambda.updateFunctionConfiguration({
      FunctionName,
      Environment: { Variables }
    }).promise()
  }))
}

export const xor = (...args) => args.reduce((acc, next) => {

}, false)

const isLocal = ({ local, remote, project }: ConfOpts) => {
  if (local && remote) {
    throw new CustomErrors.InvalidInput('expected "local" or "remote" but not both')
  }

  if (local) {
    if (!project) {
      throw new CustomErrors.InvalidInput('expected "project", the path to your local serverless project')
    }

    if (!isValidProjectPath(project)) {
      throw new CustomErrors.InvalidInput('expected "project" to point to serverless project dir')
    }

    return true
  }

  if (typeof remote === 'boolean') {
    return !remote
  }

  return !!project
}

export const normalizeConfOpts = (opts: ConfOpts):ConfOpts => {
  const local = isLocal(opts)
  return {
    ...opts,
    local,
    remote: !local,
  }
}

export const isRemoteOnlyCommand = commandName => REMOTE_ONLY_COMMANDS.includes(commandName)
export const isSafeRemoteCommand = commandName => SAFE_REMOTE_COMMANDS.includes(commandName)

export const createQRCode = (...args) => {
  const QRCode = require('qrcode')
  const toFile = promisify(QRCode.toFile.bind(QRCode))
  return toFile(...args)
}

const normalizeError = err => {
  if (err instanceof Error) return err

  const { name, message='unspecified' } = err
  let normalized
  if (name && name in global) {
    const ctor = global[name]
    try {
      normalized = new ctor(name)
    } catch (err) {}
  }

  if (!normalized) {
    normalized = new Error(message)
  }

  _.extend(normalized, err)
  return normalized
  // return new Error(JSON.stringify(err))
}

export const unwrapReturnValue = ret => {
  const { error, result } = ret
  if (error) {
    return {
      ...ret,
      error: normalizeError(error),
    }
  }

  if (result) {
    if (result.error || result.result) {
      return unwrapReturnValue(result)
    }
  }

  return ret
}

type Promiser<T> = (item:T) => Promise<void|any>

export const series = async <T>(arr:T[], exec:Promiser<T>) => {
  for (const item of arr) {
    await exec(item)
  }
}

export const requireOption = (obj: any, option: string, type: 'string'|'number'|'object') => {
  if (typeof obj[option] !== type) {
    throw new CustomErrors.InvalidInput(`expected ${type} "${option}"`)
  }
}

export const parseStackArn = (arn: string) => {
  // arn:aws:cloudformation:us-east-1:123456789012:stack/stack-name/d8d99a40-c13f-11e8-a6d8-50d5cd1ea8d2
  const [
    region,
    accountId,
    more,
  ] = arn.split(':').slice(3)

  const [
    stackName,
    id,
  ] = more.split('/').slice(1)

  return { region, accountId, stackName }
}

export const splitOnCharAtIdx = (str: string, idx: number) => {
  return [
    str.slice(0, idx),
    str.slice(idx + 1),
  ]
}

const capFirst = (str: string) => str[0].toUpperCase() + str.slice(1)

export const toCamelCase = (str: string, delimiter: string=' ') => {
  return str.split(delimiter)
    .filter(_.identity)
    .map((part, i) => i === 0 ? part : capFirst(part))
    .join('')
}

type ClientOpts = {
  region: string
  profile?: string
}

const createClientOpts = ({ profile, region }: ClientOpts) => {
  const opts:any = { region }
  if (profile) {
    opts.credentials = new AWS.SharedIniFileCredentials({ profile })
  }

  return opts
}

export const createCloudFormationClient = (opts: ClientOpts) => new AWS.CloudFormation(createClientOpts(opts))
export const createDynamoDBClient = (opts: ClientOpts) => new AWS.DynamoDB(createClientOpts(opts))
export const createS3Client = (opts: ClientOpts) => new AWS.S3(createClientOpts(opts))
