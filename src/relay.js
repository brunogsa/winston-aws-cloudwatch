'use strict'

import _debug from 'debug'
import Bottleneck from 'bottleneck'
import defaults from 'defaults'
import Queue from './queue'
import {EventEmitter} from 'events'

const debug = _debug('winston-aws-cloudwatch:Relay')

export default class Relay extends EventEmitter {
  constructor (client, options) {
    super()
    debug('constructor', {client, options})
    this._client = client
    this._options = defaults(options, {
      submissionInterval: 2000,
      batchSize: 20
    })
    this._limiter = null
    this._queue = null
  }

  start () {
    debug('start')
    if (this._queue) {
      throw new Error('Already started')
    }
    this._limiter = new Bottleneck(1, this._options.submissionInterval, 1)
    this._queue = new Queue()
    // Initial call to postpone first submission
    this._limiter.schedule(() => Promise.resolve())
  }

  submit (item) {
    this._queue.push(item)
    this._scheduleSubmission()
  }

  _scheduleSubmission () {
    debug('scheduleSubmission')
    this._limiter.schedule(() => this._submit())
  }

  _submit () {
    if (this._queue.size === 0) {
      debug('submit: queue empty')
      return Promise.resolve()
    }
    const batch = this._queue.head(this._options.batchSize)
    debug(`submit: submitting ${batch.length} item(s)`)
    return this._client.submit(batch)
      .then(() => this._onSubmitted(batch), (err) => this._onError(err, batch))
      .then(() => this._scheduleSubmission())
  }

  _onSubmitted (batch) {
    debug('onSubmitted', {batch})
    this._queue.remove(batch.length)
    for (let i = 0; i < batch.length; ++i) {
      const item = batch[i]
      item.callback(null, true)
    }
  }

  _onError (err, batch) {
    debug('onError', {error: err})
    // Expected errors:
    // - DataAlreadyAcceptedException
    //   Message: "The given batch of log events has already been accepted."
    //   Action: Assume the request got replayed and remove the batch.
    // - InvalidSequenceTokenException
    //   Message: "The given sequenceToken is invalid."
    //   Action: Keep the items in the queue and retry next time.
    if (err.code === 'DataAlreadyAcceptedException') {
      this._queue.remove(batch.length)
    } else if (err.code !== 'InvalidSequenceTokenException') {
      this.emit('error', err)
    }
  }
}
