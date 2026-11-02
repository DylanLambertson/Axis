// Opens the prototype in headless Chrome, waits for the shell, prints startup marks and console errors,
// and saves a screenshot. Usage: node scripts/open.mjs <url> <screenshot.png>
import { launchChrome } from './cdp.mjs'

const [url = 'http://127.0.0.1:5174/', shot = 'open.png'] = process.argv.slice(2)
const { child, page } = await launchChrome()
const errors = []
page.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text))
page.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') errors.push(p.args.map((a) => a.value ?? a.description).join(' '))
})
try {
  const t0 = Date.now()
  await page.send('Page.navigate', { url })
  await page.waitFor("window.__axisMarks && window.__axisMarks['axis:shell:mounted']", 180_000)
  const wall = Date.now() - t0
  await new Promise((r) => setTimeout(r, 4000))
  console.log(JSON.stringify({ wallToShellMs: wall, marks: await page.eval('window.__axisMarks') }))
  await page.screenshot(shot)
} finally {
  console.log(JSON.stringify({ errors: errors.slice(0, 30) }, null, 1))
  page.close()
  child.kill()
}
