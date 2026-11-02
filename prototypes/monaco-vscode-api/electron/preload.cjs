// Sandboxed preload: exposes only the narrow bridge typed in src/types.d.ts (AxisNodeBridge).
const { contextBridge, ipcRenderer } = require('electron')

// Passed by main.cjs through webPreferences.additionalArguments so it is available synchronously.
const workspacePath = process.argv.find((a) => a.startsWith('--axis-workspace='))?.slice('--axis-workspace='.length)

contextBridge.exposeInMainWorld('axisNode', {
  workspacePath,
  fs: {
    stat: (p) => ipcRenderer.invoke('fs:stat', p),
    readdir: (p) => ipcRenderer.invoke('fs:readdir', p),
    readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
    writeFile: (p, content) => ipcRenderer.invoke('fs:writeFile', p, content),
    mkdir: (p) => ipcRenderer.invoke('fs:mkdir', p),
    delete: (p, recursive) => ipcRenderer.invoke('fs:delete', p, recursive),
    rename: (from, to) => ipcRenderer.invoke('fs:rename', from, to)
  },
  shell: {
    spawn: (cwd) => ipcRenderer.invoke('shell:spawn', cwd),
    write: (id, data) => ipcRenderer.send('shell:write', id, data),
    kill: (id) => ipcRenderer.send('shell:kill', id),
    onData: (listener) => ipcRenderer.on('shell:data', (_e, id, data) => listener(id, data)),
    onExit: (listener) => ipcRenderer.on('shell:exit', (_e, id, code) => listener(id, code))
  }
})
