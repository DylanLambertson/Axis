// Workspace mounting.
// Browser: an in-memory sample TypeScript project under file:///workspace.
// Electron: a file:// overlay backed by Node fs in the main process (electron/main.cjs), limited to one folder.
import {
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileType,
  RegisteredFileSystemProvider,
  RegisteredMemoryFile,
  registerFileSystemOverlay,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IStat
} from '@codingame/monaco-vscode-files-service-override'
import * as vscode from 'vscode'

export interface MountedWorkspace {
  folder: vscode.Uri
  firstFile: vscode.Uri
}

const sample: Record<string, string> = {
  'tsconfig.json': JSON.stringify(
    { compilerOptions: { target: 'es2022', module: 'esnext', strict: true }, include: ['src'] },
    null,
    2
  ),
  'src/math.ts': 'export function add(a: number, b: number): number {\n  return a + b\n}\n',
  'src/index.ts': [
    "import { add } from './math'",
    '',
    '// Two deliberate type errors so diagnostics are visible:',
    "const total: number = add(1, '2')",
    'const label: string = total',
    '',
    'console.log(label)',
    ''
  ].join('\n'),
  // Unformatted on purpose: Prettier (from Open VSX) rewrites quotes and semicolons, the built-in formatter does not.
  'src/messy.ts': "export const greeting   =  'hello'\nexport function shout(s:string){return s.toUpperCase()}\n",
  'README.md': '# Sample workspace\n\nIn-memory files for the Axis M4 monaco-vscode-api prototype.\n'
}

function mountMemoryWorkspace(): MountedWorkspace {
  const provider = new RegisteredFileSystemProvider(false)
  for (const [path, content] of Object.entries(sample)) {
    provider.registerFile(new RegisteredMemoryFile(vscode.Uri.file(`/workspace/${path}`), content))
  }
  registerFileSystemOverlay(1, provider)
  return {
    folder: vscode.Uri.file('/workspace'),
    firstFile: vscode.Uri.file('/workspace/src/index.ts')
  }
}

const typeMap: Record<string, FileType> = {
  file: FileType.File,
  directory: FileType.Directory,
  symlink: FileType.SymbolicLink,
  unknown: FileType.Unknown
}

/** Maps errors from the IPC boundary (Node `code` strings) onto VS Code provider errors. */
function toProviderError(error: unknown): FileSystemProviderError {
  const message = error instanceof Error ? error.message : String(error)
  const code = /ENOENT/.test(message)
    ? FileSystemProviderErrorCode.FileNotFound
    : /EEXIST/.test(message)
      ? FileSystemProviderErrorCode.FileExists
      : /EISDIR/.test(message)
        ? FileSystemProviderErrorCode.FileIsADirectory
        : /EACCES|EPERM|outside workspace/.test(message)
          ? FileSystemProviderErrorCode.NoPermissions
          : FileSystemProviderErrorCode.Unknown
  return FileSystemProviderError.create(message, code)
}

class NodeBridgeFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive
  private readonly changeEmitter = new vscode.EventEmitter<readonly never[]>()
  readonly onDidChangeCapabilities = new vscode.EventEmitter<void>().event
  readonly onDidChangeFile = this.changeEmitter.event

  constructor(
    private readonly bridge: AxisNodeBridge,
    private readonly root: string
  ) {}

  private inRoot(resource: vscode.Uri): string {
    const path = resource.path
    if (path !== this.root && !path.startsWith(this.root + '/')) {
      // Let lower-priority overlays (or nothing) answer for paths outside the opened folder.
      throw FileSystemProviderError.create('outside workspace', FileSystemProviderErrorCode.FileNotFound)
    }
    return path
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof FileSystemProviderError) throw error
      throw toProviderError(error)
    }
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined) // No file watching in the prototype.
  }

  stat(resource: vscode.Uri): Promise<IStat> {
    return this.call(async () => {
      const stat = await this.bridge.fs.stat(this.inRoot(resource))
      return { type: typeMap[stat.type] ?? FileType.Unknown, size: stat.size, mtime: stat.mtime, ctime: stat.ctime }
    })
  }

  readdir(resource: vscode.Uri): Promise<[string, FileType][]> {
    return this.call(async () =>
      (await this.bridge.fs.readdir(this.inRoot(resource))).map(([name, type]) => [name, typeMap[type] ?? FileType.Unknown])
    )
  }

  readFile(resource: vscode.Uri): Promise<Uint8Array> {
    return this.call(() => this.bridge.fs.readFile(this.inRoot(resource)))
  }

  writeFile(resource: vscode.Uri, content: Uint8Array): Promise<void> {
    return this.call(() => this.bridge.fs.writeFile(this.inRoot(resource), content))
  }

  mkdir(resource: vscode.Uri): Promise<void> {
    return this.call(() => this.bridge.fs.mkdir(this.inRoot(resource)))
  }

  delete(resource: vscode.Uri, opts: { recursive: boolean }): Promise<void> {
    return this.call(() => this.bridge.fs.delete(this.inRoot(resource), opts.recursive))
  }

  rename(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    return this.call(() => this.bridge.fs.rename(this.inRoot(from), this.inRoot(to)))
  }
}

function mountNodeWorkspace(bridge: AxisNodeBridge): MountedWorkspace {
  const root = bridge.workspacePath
  // The provider's method signatures use the public vscode types; the overlay expects the internal ones,
  // which are structurally the same at runtime.
  registerFileSystemOverlay(
    1,
    new NodeBridgeFileSystemProvider(bridge, root) as unknown as IFileSystemProviderWithFileReadWriteCapability
  )
  return { folder: vscode.Uri.file(root), firstFile: vscode.Uri.file(`${root}/src/index.ts`) }
}

export async function mountWorkspace(): Promise<MountedWorkspace> {
  return window.axisNode ? mountNodeWorkspace(window.axisNode) : mountMemoryWorkspace()
}

export { sample as sampleWorkspaceFiles }
