'use strict'
let mStopFlag = true
let mRootDirHandle


function formatSize(n) {
  let i = 0
  while (n >= 1024) {
    n /= 1024
    i++
  }
  if (i === 0) {
    return n + 'B'
  }
  return n.toFixed(1) + 'kMGTP'[i - 1]
}

function escEntity(str, reg) {
  return str.replace(reg, s => '&#' + s.charCodeAt(0) + ';')  
}

function escHtml(str) {
  return escEntity(str, /&|<|>/g)
    .replace(/\s/g, '&nbsp;')
}

function escAttr(str) {
  return escEntity(str, /&|"/g)
}

async function listDir(dirHandle, dirPath) {
  const DIR_PREFIX = '\x00'   // for sort
  const keys = []
  const sizeMap = {}

  if (dirPath !== '/') {
    keys[0] = DIR_PREFIX + '..'
  }

  for await (const [name, handle] of dirHandle) {
    if (handle.kind === 'file') {
      keys.push(name)
      const file = await handle.getFile()
      sizeMap[name] = file.size
    } else {
      keys.push(DIR_PREFIX + name)
    }
  }

  const tableRows = keys.sort().map(key => {
    let icon, size, name

    if (key.startsWith(DIR_PREFIX)) {
      icon = '📂'
      size = ''
      name = key.substr(DIR_PREFIX.length) + '/'
    } else {
      icon = '📄'
      size = formatSize(sizeMap[key])
      name = key
    }
    return `\
    <tr>
      <td class="icon">${icon}</td>
      <td class="size">${size}</td>
      <td class="name"><a href="${escAttr(name)}">${escHtml(name)}</a></td>
    </tr>`
  })

  const now = new Date().toLocaleString()
  const html = `\
<!doctype html>
<html>
<head>
  <title>Index of ${escHtml(dirPath)}</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <style>
    td {
      font-family: monospace;
    }
    td.size {
      text-align: right;
      width: 4em;
    }
    td.name {
      padding-left: 1em;
    }
  </style>
</head>
<body>
  <h1>Index of ${escHtml(dirPath)}</h1>
  <table>
${tableRows.join('\n')}
  </table>
  <br>
  <address>Powered by Service Worker (${now})</address>
</body>
</html>`

  return new Response(html, {
    headers: {
      'content-type': 'text/html',
    },
  })
}

async function find404(dirHandles) {
  for (const dirHandle of dirHandles.reverse()) {
    const fileHandle = await getSubFile(dirHandle, '404.html')
    if (fileHandle) {
      const file = await fileHandle.getFile()
      return new Response(file.stream(), {
        status: 404,
        headers: {
          'content-type': file.type,
        },
      })
    }
  }
}

function make404() {
  return new Response('404 Not Found', {
    status: 404,
  })
}

async function getSubDir(dirHandle, dirName) {
  try {
    return await dirHandle.getDirectoryHandle(dirName)
  } catch {
  }
}

async function getSubFile(dirHandle, fileName) {
  try {
    return await dirHandle.getFileHandle(fileName)
  } catch {
  }
}

async function getSubFileOrDir(dirHandle, fileName) {
  return await getSubFile(dirHandle, fileName) ||
    await getSubDir(dirHandle, fileName)
}

/**
 * @param {URL} url 
 * @param {Request} req 
 */
async function respond(url, req) {
  if (url.search === '?stop' && req.mode === 'navigate') {
    console.log('[sw] stop server')
    mStopFlag = true
    return Response.redirect('/')
  }

  if (await mRootDirHandle.queryPermission({mode: 'read'}) !== 'granted') {
    console.log('[sw] permission expired')
    mStopFlag = true
    return Response.redirect('/')
  }

  const dirNames = decodeURI(url.pathname).replace(/^\/+/, '').split(/\/+/)
  const fileName = dirNames.pop() || 'index.html'
  const dirHandles = [mRootDirHandle]
  let dirHandle = mRootDirHandle
  let dirPath = '/'

  for (const dir of dirNames) {
    dirHandle = await getSubDir(dirHandle, dir)
    if (!dirHandle) {
      return await find404(dirHandles) || make404()
    }
    dirHandles.push(dirHandle)
    dirPath += `${dir}/`
  }

  const handle = await getSubFileOrDir(dirHandle, fileName)
  if (!handle) {
    const res = await find404(dirHandles)
    if (res) {
      return res
    }
    return fileName === 'index.html'
      ? listDir(dirHandle, dirPath)
      : make404()
  }

  if (handle.kind === 'directory') {
    return Response.redirect(dirPath + fileName + '/')
  }

  /** @type {File} */
  let file = await handle.getFile()

  /** @type {ResponseInit} */
  const resOpt = {
    headers: {
      'content-type': file.type || 'text/plain',
    },
  }

  const range = req.headers.get('range')
  if (range) {
    // only consider `bytes=begin-end` or `bytes=begin-`
    const m = range.match(/bytes=(\d+)-(\d*)/)
    if (m) {
      const size = file.size
      const begin = +m[1]
      const end = +m[2] || size

      file = file.slice(begin, end)
      resOpt.status = 206
      resOpt.headers['content-range'] = `bytes ${begin}-${end-1}/${size}`
    }
  }

  resOpt.headers['content-length'] = file.size
  return new Response(file.stream(), resOpt)
}

onfetch = (e) => {
  if (mStopFlag) {
    return
  }
  console.assert(mRootDirHandle)

  const req = e.request
  const url = new URL(req.url)
  if (url.origin !== location.origin) {
    return
  }
  e.respondWith(respond(url, req))
}

onmessage = (e) => {
  if (mStopFlag) {
    mRootDirHandle = e.data
    mStopFlag = false
    e.source.postMessage('GOT')
  }
}

onactivate = () => {
  clients.claim()
}