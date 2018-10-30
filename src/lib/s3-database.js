import AWS from 'aws-sdk'
import {log} from './log'

export const read = () => new Promise((resolve, reject) => {
  const Bucket = process.env.AWS_S3_BUCKET
  const Key = process.env.AWS_S3_KEY
  const s3 = new AWS.S3()
  s3.getObject({ Bucket, Key }, (err, data) => {
    if (err) {
      log('s3 db read error:')
      log(err)
      return reject(err)
    }
    const jsonString = data.Body.toString('utf8')
    //console.log('Loaded database from S3:', jsonString)
    resolve(JSON.parse(jsonString))
  })
})

export const write = json => new Promise((resolve, reject) => {
  const Bucket = process.env.AWS_S3_BUCKET
  const Key = process.env.AWS_S3_KEY
  const s3 = new AWS.S3()
  s3.putObject({ Bucket, Key, Body: JSON.stringify(json, null, 2) }, (err) => {
    if (err) {
      log('s3 db write error:')
      log(err)
      return reject(err)
    }
    resolve(true)
  })
})
