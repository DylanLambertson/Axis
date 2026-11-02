// Terminal backends.
// Browser: an echo terminal (no shell exists in a browser without a server).
// Electron: a pipe-backed /bin/sh in the main process. It is not a pty (no node-pty, which needs a native
// build): no job control, no line editing, no full-screen programs. A real pty needs node-pty or a `reh` server.
import {
  SimpleTerminalBackend,
  SimpleTerminalProcess,
  type ITerminalChildProcess
} from '@codingame/monaco-vscode-terminal-service-override'
import * as vscode from 'vscode'

const PROMPT = '\x1b[32m$\x1b[0m '

export class EchoTerminalBackend extends SimpleTerminalBackend {
  override getDefaultSystemShell = async (): Promise<string> => 'echo'
  override createProcess = async (): Promise<ITerminalChildProcess> => {
    const data = new vscode.EventEmitter<string>()
    class EchoProcess extends SimpleTerminalProcess {
      private line = ''
      async start(): Promise<undefined> {
        data.fire(`Echo terminal (browser build has no shell; see the prototype report)\r\n${PROMPT}`)
        return undefined
      }
      override input(chunk: string): void {
        for (const c of chunk) {
          if (c === '\r') {
            data.fire(`\r\n${this.line}\r\n${PROMPT}`)
            this.line = ''
          } else if (c === '\x7f') {
            if (this.line.length > 0) {
              this.line = this.line.slice(0, -1)
              data.fire('\b \b')
            }
          } else {
            this.line += c
            data.fire(c)
          }
        }
      }
      resize(): void {}
      override shutdown(): void {}
      override clearBuffer(): void {}
      override sendSignal(): void {}
    }
    return new EchoProcess(1, 1, '/workspace', data.event)
  }
}

export class NodeTerminalBackend extends SimpleTerminalBackend {
  override getDefaultSystemShell = async (): Promise<string> => '/bin/sh'
  override createProcess = async (): Promise<ITerminalChildProcess> => {
    const bridge = window.axisNode!
    const data = new vscode.EventEmitter<string>()
    const id = await bridge.shell.spawn(bridge.workspacePath)
    bridge.shell.onData((from, chunk) => {
      if (from === id) data.fire(chunk.replace(/\r?\n/g, '\r\n'))
    })
    bridge.shell.onExit((from, code) => {
      if (from === id) data.fire(`\r\n[process exited with code ${code}]\r\n`)
    })
    class PipeProcess extends SimpleTerminalProcess {
      private line = ''
      async start(): Promise<undefined> {
        data.fire(`/bin/sh over pipes (not a pty)\r\n${PROMPT}`)
        return undefined
      }
      override input(chunk: string): void {
        // Local line editing, because a pipe has no tty discipline.
        for (const c of chunk) {
          if (c === '\r') {
            data.fire('\r\n')
            bridge.shell.write(id, this.line + '\n')
            this.line = ''
            setTimeout(() => data.fire(PROMPT), 150)
          } else if (c === '\x7f') {
            if (this.line.length > 0) {
              this.line = this.line.slice(0, -1)
              data.fire('\b \b')
            }
          } else {
            this.line += c
            data.fire(c)
          }
        }
      }
      resize(): void {}
      override shutdown(): void {
        bridge.shell.kill(id)
      }
      override clearBuffer(): void {}
      override sendSignal(): void {}
    }
    return new PipeProcess(id, id, bridge.workspacePath, data.event)
  }
}
