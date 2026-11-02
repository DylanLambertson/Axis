import {
  attachPart,
  isPartVisibile,
  onPartVisibilityChange,
  type Parts
} from '@codingame/monaco-vscode-views-service-override'
import { useLayoutEffect, useRef, useState } from 'react'

/** A React-owned box that hosts one VS Code workbench part. React owns the box; VS Code owns its contents. */
export function PartHost({ part, className }: { part: Parts; className: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(() => isPartVisibile(part))

  useLayoutEffect(() => {
    const attached = attachPart(part, ref.current!)
    const visibility = onPartVisibilityChange(part, setVisible)
    return () => {
      visibility.dispose()
      attached.dispose()
    }
  }, [part])

  return <div ref={ref} className={`part ${className}`} data-part={part} hidden={!visible} />
}
