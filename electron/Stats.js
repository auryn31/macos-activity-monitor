const util = require('util')
const exec = util.promisify(require('child_process').exec)
const ev = require('../src/utils/events')

const cpuUsageCommand = 'top -l 1 -stats "pid,command,cpu" -n 0 |grep CPU'
const memoryStatsCommand = 'vm_stat'
const memorySizeCommand = 'sysctl -n hw.memsize'
const netStatCommand = 'nettop -x -k state -k interface -k rx_dupe -k rx_ooo -k re-tx -k rtt_avg -k rcvsize -k tx_win -k tc_class -k tc_mgt -k cc_algo -k P -k C -k R -k W -l 1 -t wifi -t wired'
const unitDivisor = 1048576 //MB
const MAX_RESULT_CACHE = 100

class Stats {
  /**
   * @param {*} emitEvent Emit event to main process
   * @param {*} getSetting Get a setting
   */
  constructor(emitEvent, getSetting) {
    this.results = []
    this.getSetting = getSetting
    this.interval = getSetting('interval')
    this.emitEvent = emitEvent
    this.lastUploadVal = -1.0
    this.lastDownloadVal = -1.0
  }
  setImageManager(imageManager) {
    this.imageManager = imageManager
  }
  setInterval(interval) {
    this.interval = interval
  }
  saveResults(result) {
    this.results.push(result)
    this.results = this.results.slice(-MAX_RESULT_CACHE)
  }
  getPreviousStats() {
    return this.results
  }
  /**
   * Get all stats available
   */
  async getAll() {
    let cpuStats = await this.getCPUStats()
    let memoryStats = await this.getMemoryStats()
    let networkStats = await this.getUpDownloadStats()

    return {
      memory: memoryStats,
      cpu: cpuStats,
      network: networkStats
    }
  }
  /**
   * Get memory stats
   */
  async getMemoryStats() {
    //Total memory available
    const memorySizeResult = await exec(memorySizeCommand)

    if (memorySizeResult.stderr) {
      return
    }

    const totalMemory = parseInt(memorySizeResult.stdout / unitDivisor)

    //Memory stats
    const memoryStatsResult = await exec(memoryStatsCommand)

    if (memoryStatsResult.stderr) {
      return
    }

    let lines = memoryStatsResult.stdout.split('\n')

    let pageFree = parseInt(lines[1].match(/\d+/)[0]) * 4096 / unitDivisor
    let pageInactive = parseInt(lines[3].match(/\d+/)[0]) * 4096 / unitDivisor
    let pageWired = parseInt(lines[6].match(/\d+/)[0]) * 4096 / unitDivisor
    let pagePurgeable = parseInt(lines[7].match(/\d+/)[0]) * 4096 / unitDivisor
    let pageAnonymous = parseInt(lines[14].match(/\d+/)[0]) * 4096 / unitDivisor
    let pageCompressed = parseInt(lines[16].match(/\d+/)[0]) * 4096 / unitDivisor

    let appMemory = pageAnonymous + pagePurgeable
    let memoryUsed = appMemory + pageWired + pageCompressed

    let percentageUsed = parseInt((memoryUsed / totalMemory) * 100)
    let memoryFree = pageFree + pageInactive

    return {
      percentage: {
        used: percentageUsed,
      },
      free: memoryFree,
      used: memoryUsed,
    }
  }
  /**
   * Get CPU stats
   */
  async getCPUStats() {
    const { stdout, stderr } = await exec(cpuUsageCommand)

    if (stderr) {
      return
    }

    const regex = /(\d+.\d+%)/g
    let [CPUuser, CPUsystem, CPUidle] = stdout.match(regex)
    let CPUusedPercentage = parseInt(CPUuser) + parseInt(CPUsystem)

    return {
      percentage: {
        used: CPUusedPercentage,
        user: parseInt(CPUuser),
        system: parseInt(CPUsystem),
        idle: parseInt(CPUidle),
      }
    }
  }
  /**
   * Get stats and update the UI
   */
  async updateStats() {
    const result = await this.getAll()    

    this.saveResults(result)

    this.emitEvent(ev.STATS_UPDATED, {
      results: this.results,
      interval: this.interval,
    })

    let iconOpts = [
      { indicator: 'mem', value: result.memory.percentage.used, unit: 'percentage' },
      { indicator: 'cpu', value: result.cpu.percentage.used, unit: 'percentage' },
      { indicator: 'dow', value: result.network.download, unit: 'mbs' },
      { indicator: 'up', value: result.network.upload, unit: 'mbs' }
    ]

    //draw the icon
    this.imageManager.drawIcons(iconOpts)

    //update stats again every "x" interval
    setTimeout(() => this.updateStats(), this.interval)
  }

  async getUpDownloadStats() {
    const { stdout, stderr } = await exec(netStatCommand)

    if (stderr) {
      return
    }

    const regex = /(\.\d+\s+(\d+)\s+(\d+)\n)/g
    let lines = stdout.match(regex)
    lines = lines.map(line=> line.split(' ').filter( a => a!=='').map(a=>a.replace('\n','')))
    lines.forEach(a=> a.shift())
    var upload = 0.0
    var download = 0.0
    lines.forEach(line => {
      upload += parseFloat(line[1])
      download += parseFloat(line[0])
    })
    upload /= (this.interval * 1000)
    download /= (this.interval * 1000)
    var currentUpload = upload - this.lastUploadVal
    var currentDownload = download - this.lastDownloadVal

    currentUpload = Math.round(currentUpload * 10) / 10
    currentDownload = Math.round(currentDownload * 10) / 10

    var threshhold = 0.1
    if(currentUpload < threshhold) {
      currentUpload = 0
    }
    if(currentDownload < threshhold) {
      currentDownload = 0
    }

    this.lastUploadVal = upload
    this.lastDownloadVal = download
    return {
      download: currentDownload,
      upload: currentUpload
    }
  }
}

module.exports = Stats