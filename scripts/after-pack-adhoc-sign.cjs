// electron-builder afterPack hook: ad-hoc sign the whole app bundle on macOS.
//
// We distribute unsigned (pseudonymous publisher, no Apple Developer account),
// but Apple Silicon REFUSES to run binaries with no signature at all — an
// ad-hoc signature (identity "-") is the minimum that executes. Downloaded
// builds still carry the quarantine flag; users clear it once with
// `xattr -cr` (documented in the README and release notes).
const {execFileSync} = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {stdio: 'inherit'})
  console.log(`ad-hoc signed ${appPath}`)
}
