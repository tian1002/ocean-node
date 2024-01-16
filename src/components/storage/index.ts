import { Service } from '../../@types/DDO/Service.js'
import {
  UrlFileObject,
  IpfsFileObject,
  ArweaveFileObject,
  StorageReadable,
  FileInfoRequest,
  FileInfoResponse
} from '../../@types/fileObject.js'
import { AssetUtils } from '../../utils/asset.js'
import { decrypt } from '../../utils/crypt.js'
import { OceanP2P } from '../P2P/index.js'
import { FindDdoHandler } from '../core/ddoHandler.js'
import axios from 'axios'
import urlJoin from 'url-join'

async function getFileEndpoint(
  did: string,
  serviceId: string,
  node: OceanP2P
): Promise<UrlFileObject[] | ArweaveFileObject[] | IpfsFileObject[]> {
  // 1. Get the DDO
  const ddo = await new FindDdoHandler(node).findAndFormatDdo(did)
  // 2. Get the service
  const service: Service = AssetUtils.getServiceById(ddo, serviceId)
  // 3. Decrypt the url
  const decryptedUrlBytes = await decrypt(
    Uint8Array.from(Buffer.from(service.files, 'hex')),
    'ECIES'
  )
  // Convert the decrypted bytes back to a string
  const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
  const decryptedFileArray = JSON.parse(decryptedFilesString)
  return decryptedFileArray.files
}

async function fetchFileMetadata(
  url: string
): Promise<{ contentLength: string; contentType: string }> {
  let contentLength: string = ''
  let contentType: string = ''
  try {
    // First try with HEAD request
    const response = await axios.head(url)

    contentLength = response.headers['content-length']
    contentType = response.headers['content-type']
  } catch (error) {
    // Fallback to GET request
    try {
      const response = await axios.get(url, { method: 'GET', responseType: 'stream' })

      contentLength = response.headers['content-length']
      contentType = response.headers['content-type']
    } catch (error) {
      console.error('Error downloading file:', error.message)
    }
  }

  if (!contentLength) {
    try {
      const response = await axios.get(url, { responseType: 'stream' })
      let totalSize = 0

      for await (const chunk of response.data) {
        totalSize += chunk.length
      }
      contentLength = totalSize.toString()
    } catch (error) {
      console.error('Error downloading file:', error)
      contentLength = 'Unknown'
    }
  }
  return {
    contentLength,
    contentType
  }
}

export abstract class Storage {
  private file: any
  public constructor(file: any) {
    this.file = file
  }

  abstract validate(): [boolean, string]

  abstract getDownloadUrl(): string
  abstract fetchSpecificFileMetadata(fileObject: any): Promise<FileInfoResponse>

  getFile(): any {
    return this.file
  }

  static getStorageClass(file: any): UrlStorage | IpfsStorage | ArweaveStorage {
    const { type } = file
    switch (type) {
      case 'url':
        return new UrlStorage(file)
      case 'ipfs':
        return new IpfsStorage(file)
      case 'arweave':
        return new ArweaveStorage(file)
      default:
        throw new Error(`Invalid storage type: ${type}`)
    }
  }

  async getFileInfo(
    fileInfoRequest: FileInfoRequest,
    p2pNode?: OceanP2P
  ): Promise<FileInfoResponse[]> {
    if (!fileInfoRequest.type && !fileInfoRequest.did) {
      throw new Error('Either type or did must be provided')
    }
    if (!fileInfoRequest.type && !fileInfoRequest.serviceId) {
      throw new Error('serviceId is required when type is not provided')
    }

    const response: FileInfoResponse[] = []

    try {
      const filesArray = fileInfoRequest.type
        ? [this.file]
        : await getFileEndpoint(fileInfoRequest.did, fileInfoRequest.serviceId, p2pNode)

      if (!filesArray || filesArray.length === 0) {
        throw new Error('Empty files array')
      } else if (fileInfoRequest.fileIndex) {
        const fileObject = filesArray[fileInfoRequest.fileIndex]
        const fileInfo = await this.fetchSpecificFileMetadata(fileObject)
        response.push(fileInfo)
      } else {
        for (const fileObject of filesArray) {
          const fileInfo = await this.fetchSpecificFileMetadata(fileObject)
          response.push(fileInfo)
        }
      }
    } catch (error) {
      console.log(error)
    }
    return response
  }
}

export class UrlStorage extends Storage {
  public constructor(file: UrlFileObject) {
    super(file)
    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validationg the URL file: ${message}`)
    }
  }

  validate(): [boolean, string] {
    const file: UrlFileObject = this.getFile()
    if (!file.url || !file.method) {
      return [false, 'URL or method are missing']
    }
    if (!['get', 'post'].includes(file.method.toLowerCase())) {
      return [false, 'Invalid method for URL']
    }
    if (this.isFilePath() === true) {
      return [false, 'URL looks like a file path']
    }

    return [true, '']
  }

  isFilePath(): boolean {
    const regex: RegExp = /^(.+)\/([^/]+)$/ // The URL should not represent a path
    const { url } = this.getFile()
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return false
    }

    return regex.test(url)
  }

  getDownloadUrl(): string {
    if (this.validate()[0] === true) {
      return this.getFile().url
    }
    return null
  }

  async getReadableStream(): Promise<StorageReadable> {
    const input = this.getDownloadUrl()
    const response = await axios({
      method: 'get',
      url: input,
      responseType: 'stream'
    })
    return {
      httpStatus: response.status,
      stream: response.data,
      headers: response.headers as any
    }
  }

  async fetchSpecificFileMetadata(fileObject: UrlFileObject): Promise<FileInfoResponse> {
    const { url } = fileObject
    const { contentLength, contentType } = await fetchFileMetadata(url)
    return {
      valid: true,
      contentLength,
      contentType,
      name: new URL(url).pathname.split('/').pop() || '',
      type: 'url'
    }
  }
}

export class ArweaveStorage extends Storage {
  public constructor(file: ArweaveFileObject) {
    super(file)

    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validationg the Arweave file: ${message}`)
    }
  }

  validate(): [boolean, string] {
    if (!process.env.ARWEAVE_GATEWAY) {
      return [false, 'Arweave gateway is not provided!']
    }
    const file: ArweaveFileObject = this.getFile()
    if (!file.transactionId) {
      return [false, 'Missing transaction ID']
    }
    return [true, '']
  }

  getDownloadUrl(): string {
    return urlJoin(process.env.ARWEAVE_GATEWAY, this.getFile().transactionId)
  }

  async getReadableStream(): Promise<StorageReadable> {
    const input = this.getDownloadUrl()

    const response = await axios({
      method: 'get',
      url: input,
      responseType: 'stream'
    })

    return {
      httpStatus: response.status,
      stream: response.data,
      headers: response.headers as any
    }
  }

  async fetchSpecificFileMetadata(
    fileObject: ArweaveFileObject
  ): Promise<FileInfoResponse> {
    const url = urlJoin(process.env.ARWEAVE_GATEWAY, fileObject.transactionId)
    const { contentLength, contentType } = await fetchFileMetadata(url)
    return {
      valid: true,
      contentLength,
      contentType,
      name: new URL(url).pathname.split('/').pop() || '',
      type: 'arweave'
    }
  }
}

export class IpfsStorage extends Storage {
  public constructor(file: IpfsFileObject) {
    super(file)

    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validationg the IPFS file: ${message}`)
    }
  }

  validate(): [boolean, string] {
    if (!process.env.IPFS_GATEWAY) {
      return [false, 'IPFS gateway is not provided!']
    }
    const file: IpfsFileObject = this.getFile()
    if (!file.hash) {
      return [false, 'Missing CID']
    }

    return [true, '']
  }

  getDownloadUrl(): string {
    return urlJoin(process.env.IPFS_GATEWAY, urlJoin('/ipfs', this.getFile().hash))
  }

  async getReadableStream(): Promise<StorageReadable> {
    const input = this.getDownloadUrl()

    const response = await axios({
      method: 'get',
      url: input,
      responseType: 'stream'
    })

    return {
      httpStatus: response.status,
      stream: response.data,
      headers: response.headers as any
    }
  }

  async fetchSpecificFileMetadata(fileObject: IpfsFileObject): Promise<FileInfoResponse> {
    const url = urlJoin(process.env.IPFS_GATEWAY, urlJoin('/ipfs', fileObject.hash))
    const { contentLength, contentType } = await fetchFileMetadata(url)
    return {
      valid: true,
      contentLength,
      contentType,
      name: '',
      type: 'ipfs'
    }
  }
}
