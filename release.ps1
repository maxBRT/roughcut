# Ships a new version of Roughcut to GitHub: sets up the build tools, then runs npm run release.
#
#   .\release.ps1                         next patch version
#   .\release.ps1 minor                   or: major, or an exact version such as 1.2.3
#   .\release.ps1 --notes "What changed"
#
# See scripts/release.mjs for what it does and what it needs.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\tools\env.ps1"
Set-Location $PSScriptRoot
npm run release -- @args
exit $LASTEXITCODE
