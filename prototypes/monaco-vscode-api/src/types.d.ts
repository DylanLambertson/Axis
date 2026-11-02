// Bridge exposed by electron/preload.cjs. Absent in the browser build.
interface AxisNodeStat {
  type: 'file' | 'directory' | 'symlink' | 'unknown'
  size: number
  mtime: number
  ctime: number
}

interface AxisNodeBridge {
  workspacePath: string
  fs: {
    stat(path: string): Promise<AxisNodeStat>
    readdir(path: string): Promise<Array<[string, AxisNodeStat['type']]>>
    readFile(path: string): Promise<Uint8Array>
    writeFile(path: string, content: Uint8Array): Promise<void>
    mkdir(path: string): Promise<void>
    delete(path: string, recursive: boolean): Promise<void>
    rename(from: string, to: string): Promise<void>
  }
  shell: {
    spawn(cwd: string): Promise<number>
    write(id: number, data: string): void
    kill(id: number): void
    onData(listener: (id: number, data: string) => void): void
    onExit(listener: (id: number, code: number | null) => void): void
  }
}

interface Window {
  axisNode?: AxisNodeBridge
  __axisMarks?: Record<string, number>
  __axisTest?: { vscode: typeof import('vscode'); getService: typeof import('@codingame/monaco-vscode-api').getService }
}
