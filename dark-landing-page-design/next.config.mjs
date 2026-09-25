import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  agentRules: false,
  allowedDevOrigins: ['127.0.0.1'],
  images: {
    unoptimized: true,
  },
  turbopack: {
    root: projectRoot,
  },
}

export default nextConfig
