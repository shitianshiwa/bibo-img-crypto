import {RandomSequence} from './random'
import {getConfig} from './config'

let codecClasses = {}

export function createCodec () {
  let CodecClass = codecClasses[getConfig().codecName] || ShuffleBlockCodec
  return new CodecClass()
}

export function dataUrlToBlob (url) {
  let [mime, base64] = url.split(',', 2)
  mime = mime.match(/:(.*?);/)[1]
  let bin = atob(base64)
  let uint8Arr = new Uint8Array(bin.length)
  for (let i in bin) {
    uint8Arr[i] = bin.charCodeAt(i)
  }
  return new Blob([uint8Arr], {type: mime})
}

function getImgSrcToDecrypt (originSrc) {
  // 获取原图地址，防止B博缩小图片尺寸导致解密失败
  let pos = originSrc.indexOf('@')
  let src = pos === -1 ? originSrc : originSrc.substr(0, pos)
  if (!src.startsWith('data:')) {
    // 防缓存，为了跨域
    src += (src.indexOf('?') === -1 ? '?_t=' : '&_t=') + new Date().getTime()
  }
  return src
}

async function loadImage (src, isCrossOrigin = false) {
  return new Promise((resolve, reject) => {
    let img = new Image()
    if (isCrossOrigin) {
      img.crossOrigin = 'anonymous'
    }
    img.onload = () => resolve(img)
    img.onerror = e => reject(e)
    img.src = src
  })
}

class Codec {
  constructor () {
    this._canvas = document.createElement('canvas')
    this._ctx = this._canvas.getContext('2d')
    this._imgData = null
  }

  async initFromBlob (blob) {
    let blobUrl = URL.createObjectURL(blob)
    try {
      let img = await loadImage(blobUrl)
      return this._initFromImg(img)
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  }

  async initFromUrl (url) {
    let img = await loadImage(getImgSrcToDecrypt(url), true)
    return this._initFromImg(img)
  }

  async _initFromImg (img) {
    this._canvas.width = img.width
    this._canvas.height = img.height
    this._ctx.drawImage(img, 0, 0)
    this._imgData = this._ctx.getImageData(0, 0, this._canvas.width, this._canvas.height)
  }

  // 加密，返回加密后的blob
  encryptToBlob () {
    let newImgData = this._doEncrypt()
    this._canvas.width = newImgData.width
    this._canvas.height = newImgData.height
    this._ctx.putImageData(newImgData, 0, 0)
    let url = this._canvas.toDataURL()
    return dataUrlToBlob(url)
  }

  // 解密，返回解密后的data URL
  decryptToUrl () {
    let newImgData = this._doDecrypt()
    this._canvas.width = newImgData.width
    this._canvas.height = newImgData.height
    this._ctx.putImageData(newImgData, 0, 0)
    return this._canvas.toDataURL()
  }

  // 加密，返回加密后的imgData
  _doEncrypt () {}
  // 解密，返回解密后的imgData
  _doDecrypt () {}
}

// 反色
class InvertCodec extends Codec {
  _doEncrypt () { return this._invertColor() }
  _doDecrypt () { return this._invertColor() }
  _invertColor () {
    let data = this._imgData.data
    for (let i = 0; i < data.length; i += 4) {
      data[i] = ~data[i] & 0xFF
      data[i + 1] = ~data[i + 1] & 0xFF
      data[i + 2] = ~data[i + 2] & 0xFF
    }
    return this._imgData
  }
}
codecClasses.InvertCodec = InvertCodec

// RGB随机置乱
class ShuffleRgbCodec extends Codec {
  async _initFromImg (img) {
    this._canvas.width = img.width
    this._canvas.height = img.height
    // 把透明图片和白色混合，因为透明通道置乱会有问题
    this._ctx.fillStyle = '#fff'
    this._ctx.fillRect(0, 0, img.width, img.height)
    this._ctx.drawImage(img, 0, 0)
    this._imgData = this._ctx.getImageData(0, 0, this._canvas.width, this._canvas.height)
  }

  _doEncrypt () {
    let data = this._imgData.data
    let nRgbs = data.length / 4 * 3
    let seq = new RandomSequence(nRgbs, getConfig().randomSeed)
    let buffer = new Uint8ClampedArray(nRgbs)
    // 每一个RGB值放到新的位置
    for (let i = 0; i < data.length; i += 4) {
      buffer[seq.next()] = data[i]
      buffer[seq.next()] = data[i + 1]
      buffer[seq.next()] = data[i + 2]
    }
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      data[i] = buffer[j]
      data[i + 1] = buffer[j + 1]
      data[i + 2] = buffer[j + 2]
    }
    return this._imgData
  }

  _doDecrypt () {
    let data = this._imgData.data
    let nRgbs = data.length / 4 * 3
    let buffer = new Uint8ClampedArray(nRgbs)
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      buffer[j] = data[i]
      buffer[j + 1] = data[i + 1]
      buffer[j + 2] = data[i + 2]
    }
    let seq = new RandomSequence(nRgbs, getConfig().randomSeed)
    // 取新的位置，放回原来的位置
    for (let i = 0; i < data.length; i += 4) {
      data[i] = buffer[seq.next()]
      data[i + 1] = buffer[seq.next()]
      data[i + 2] = buffer[seq.next()]
    }
    return this._imgData
  }
}
codecClasses.ShuffleRgbCodec = ShuffleRgbCodec

// 块随机置乱
// 由于JPEG是分成8x8的块在块内压缩，分成8x8块处理可以避免压缩再解密造成的高频噪声
class ShuffleBlockCodec extends Codec {
  _doEncrypt () {
    return this._doCommon((result, blockX, blockY, newBlockX, newBlockY) =>
      this._copyBlock(result, newBlockX, newBlockY, this._imgData, blockX, blockY)
    )
  }

  _doDecrypt () {
    return this._doCommon((result, blockX, blockY, newBlockX, newBlockY) =>
      this._copyBlock(result, blockX, blockY, this._imgData, newBlockX, newBlockY)
    )
  }

  _doCommon (handleCopy) {
    // 尺寸不是8的倍数则去掉边界
    let blockWidth = Math.floor(this._imgData.width / 8)
    let blockHeight = Math.floor(this._imgData.height / 8)
    let result = this._ctx.createImageData(blockWidth * 8, blockHeight * 8)
    let seq = new RandomSequence(blockWidth * blockHeight, getConfig().randomSeed)
    for (let blockY = 0; blockY < blockHeight; blockY++) {
      for (let blockX = 0; blockX < blockWidth; blockX++) {
        let index = seq.next()
        let newBlockX = index % blockWidth
        let newBlockY = Math.floor(index / blockWidth)
        handleCopy(result, blockX, blockY, newBlockX, newBlockY)
      }
    }
    return result
  }

  _copyBlock (dstImgData, dstBlockX, dstBlockY, srcImgData, srcBlockX, srcBlockY) {
    let iDstStart = (dstBlockY * dstImgData.width + dstBlockX) * 8 * 4
    let iSrcStart = (srcBlockY * srcImgData.width + srcBlockX) * 8 * 4
    for (let y = 0; y < 8; y++) {
      for (let i = 0; i < 8 * 4; i++) {
        dstImgData.data[iDstStart + i] = srcImgData.data[iSrcStart + i]
      }
      iDstStart += dstImgData.width * 4
      iSrcStart += srcImgData.width * 4
    }
  }
}
codecClasses.ShuffleBlockCodec = ShuffleBlockCodec

// 连接两个图片文件，第一张图是打码的原图
class MosaicCodec extends Codec {
  constructor () {
    super()
    this._fileBuffer = null
  }

  async initFromBlob (blob) {
    let initfileBufferPromise = new Promise((resolve, reject) => {
      let reader = new FileReader()
      reader.onerror = reject
      reader.onload = event => {
        this._fileBuffer = event.target.result
        resolve()
      }
      reader.readAsArrayBuffer(blob)
    })
    let initImgDataPromise = super.initFromBlob(blob)
    return Promise.all([initfileBufferPromise, initImgDataPromise])
  }

  async initFromUrl (url) {
    let rsp = await fetch(getImgSrcToDecrypt(url))
    if (!rsp.ok) {
      throw new Error(`网络错误：${rsp.status} ${rsp.statusText}`)
    }
    return this.initFromBlob(await rsp.blob())
  }

  encryptToBlob () {
    let newImgBlob = super.encryptToBlob()
    return new Blob([newImgBlob, this._fileBuffer], {type: newImgBlob.type})
  }

  _doEncrypt () {
    const BLOCK_SIZE = 32
    for (let y = 0; y < this._imgData.height; y += BLOCK_SIZE) {
      let blockHeight = Math.min(BLOCK_SIZE, this._imgData.height - y)
      for (let x = 0; x < this._imgData.width; x += BLOCK_SIZE) {
        let blockWidth = Math.min(BLOCK_SIZE, this._imgData.width - x)
        this._mosaic(x, y, blockWidth, blockHeight)
      }
    }
    return this._imgData
  }

  _mosaic (x, y, width, height) {
    let data = this._imgData.data
    for (let iChannel = 0; iChannel < 4; iChannel++) {
      let total = 0
      let iStart = (y * this._imgData.width + x) * 4 + iChannel
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          total += data[iStart + x * 4]
        }
        iStart += this._imgData.width * 4
      }

      let average = Math.round(total / width / height)
      iStart = (y * this._imgData.width + x) * 4 + iChannel
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          data[iStart + x * 4] = average
        }
        iStart += this._imgData.width * 4
      }
    }
  }

  decryptToUrl () {
    try {
      let fileView = new DataView(this._fileBuffer)
      // 检查PNG魔数
      if (fileView.getUint32(0) !== 0x89504E47 || fileView.getUint32(4) !== 0x0D0A1A0A) {
        return ''
      }

      // 跳过第一个图片文件
      let offset = 8
      let typeCode
      do {
        let dataLength = fileView.getUint32(offset)
        typeCode = fileView.getUint32(offset + 4)
        offset += 8 + dataLength + 4
      } while (typeCode !== 0x49454E44) // IEND
      if (offset >= fileView.byteLength) {
        // 文件尾部没有数据
        return ''
      }

      // 读第二个图片文件
      let remainDataView = new DataView(this._fileBuffer, offset)
      let remainDataBlob = new Blob([remainDataView])
      return URL.createObjectURL(remainDataBlob)

    } catch {
      // 超出范围
      return ''
    }
  }
}
codecClasses.MosaicCodec = MosaicCodec
