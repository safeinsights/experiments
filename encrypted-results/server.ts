import fs from 'node:fs/promises'
import express from 'express'
import { localPath } from '../support/index';
import { encryptResults } from './encrypt'
import stream from 'stream'

// this is extracted from:
// https://github.com/bluwy/create-vite-extra/blob/master/template-ssr-vanilla/server.js

const port = process.env.PORT || 7080
const base = process.env.BASE || localPath(import.meta.url)

const app = express()

const { createServer } = await import('vite')
const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    base,
})
app.use(vite.middlewares)


app.get('/', async (req, res) => {
    const url = req.originalUrl.replace(base, '')
    const template = await fs.readFile(`./index.html`, 'utf-8')
    const html = await vite.transformIndexHtml(url, template)
    res.status(200).set({ 'Content-Type': 'text/html' }).send(html)
})


app.get('/results', async (req, res) => {
    const zip = await encryptResults(['results.csv'])
    res.set('Content-Type', 'application/zip')
    const ab = await zip.arrayBuffer()
    const readableStream = stream.Readable.from(Buffer.from(ab))
    readableStream.pipe(res)
})

// Start http server
app.listen(port, () => {
  console.log(`Server started at http://localhost:${port}`)
})
