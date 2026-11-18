# Synthesise a list of lines to separate 16 kHz mono 16-bit WAV files with Windows
# System.Speech, and record each word's start (AudioPosition of SpeakProgress).
# Note: SpeakProgress.AudioPosition is only correct when the output format is 16 kHz;
# at other rates it is scaled by rate/16000, which is why this script uses 16 kHz.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tts.ps1 -Job job.json
# job.json: { "voices": ["..."], "rate": 0, "result": "path.json",
#             "items": [ { "id": "s01", "text": "...", "wav": "path.wav" } ] }
param([Parameter(Mandatory = $true)][string]$Job)
$ErrorActionPreference = 'Stop'

$cfg = Get-Content -Raw -Encoding UTF8 -LiteralPath $Job | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

$installed = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
$voice = $null
foreach ($v in $cfg.voices) { if ($installed -contains $v) { $voice = $v; break } }
if (-not $voice) { $voice = $installed[0] }
if (-not $voice) { throw 'No System.Speech voice is installed' }
$synth.SelectVoice($voice)
$synth.Rate = [int]$cfg.rate

$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)

Register-ObjectEvent -InputObject $synth -EventName SpeakProgress -SourceIdentifier rcSpeak | Out-Null

# Progress events arrive asynchronously (late and not always in order), so each line is
# spoken as its own Prompt object, events are collected after everything is spoken, and
# they are grouped by the Prompt they belong to and sorted by character position.
$prompts = New-Object System.Collections.ArrayList
foreach ($it in $cfg.items) {
  $p = New-Object System.Speech.Synthesis.Prompt([string]$it.text)
  [void]$prompts.Add($p)
  $synth.SetOutputToWaveFile($it.wav, $fmt)
  $synth.Speak($p)
  $synth.SetOutputToNull()
}
$expected = 0
foreach ($it in $cfg.items) { $expected += @(([string]$it.text).Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)).Count }
$events = @()
for ($i = 0; $i -lt 50; $i++) {
  Start-Sleep -Milliseconds 100
  $now = @(Get-Event -SourceIdentifier rcSpeak -ErrorAction SilentlyContinue)
  if ($now.Count -ge $expected -and $now.Count -eq $events.Count) { break }
  $events = $now
}
$events = @(Get-Event -SourceIdentifier rcSpeak -ErrorAction SilentlyContinue)
Unregister-Event -SourceIdentifier rcSpeak

$results = New-Object System.Collections.ArrayList
for ($k = 0; $k -lt $cfg.items.Count; $k++) {
  $it = $cfg.items[$k]
  $p = $prompts[$k]
  $words = @($events | Where-Object { [object]::ReferenceEquals($_.SourceEventArgs.Prompt, $p) } |
    ForEach-Object { [pscustomobject]@{ text = $_.SourceEventArgs.Text; ms = $_.SourceEventArgs.AudioPosition.TotalMilliseconds; chr = $_.SourceEventArgs.CharacterPosition } } |
    Sort-Object chr)
  [void]$results.Add([pscustomobject]@{ id = $it.id; words = $words })
}
$synth.Dispose()

$out = [pscustomobject]@{ voice = $voice; items = $results.ToArray() }
$json = $out | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($cfg.result, $json, (New-Object System.Text.UTF8Encoding($false)))
