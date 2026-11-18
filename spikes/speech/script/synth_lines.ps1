# Synthesizes each line of monologue.json to its own 16 kHz mono WAV with Windows System.Speech,
# and records the word boundary positions the synthesizer reports (SpeakProgress.AudioPosition).
# Usage: powershell -File synth_lines.ps1 <monologue.json> <outDir>
param([string]$ScriptJson, [string]$OutDir)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Speech.Synthesis;
using System.Speech.AudioFormat;
public static class LineSynth {
    public static string Synth(string voice, int rate, string text, string wavPath) {
        var parts = new List<string>();
        using (var s = new SpeechSynthesizer()) {
            s.SelectVoice(voice);
            s.Rate = rate;
            s.SetOutputToWaveFile(wavPath, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            s.SpeakProgress += (o, e) => {
                parts.Add(String.Format(System.Globalization.CultureInfo.InvariantCulture,
                  "{{\"text\":\"{0}\",\"pos_ms\":{1},\"char\":{2},\"len\":{3}}}",
                  e.Text.Replace("\\","\\\\").Replace("\"","\\\""), (long)e.AudioPosition.TotalMilliseconds, e.CharacterPosition, e.CharacterCount));
            };
            s.Speak(text);
            s.SetOutputToNull();
        }
        return "[" + String.Join(",", parts) + "]";
    }
}
"@
$cfg = Get-Content -Raw -Encoding UTF8 $ScriptJson | ConvertFrom-Json
New-Item -ItemType Directory -Force $OutDir | Out-Null
$i = 0
$out = @()
foreach ($l in $cfg.lines) {
    $wav = Join-Path $OutDir ("line{0:D3}.wav" -f $i)
    $words = [LineSynth]::Synth($cfg.voice, [int]$cfg.rate, $l.text, $wav)
    $out += ('{{"index":{0},"wav":"{1}","words":{2}}}' -f $i, (Split-Path -Leaf $wav), $words)
    $i++
}
"[" + ($out -join ",`n") + "]" | Out-File -Encoding utf8 (Join-Path $OutDir "lines_words.json")
Write-Output "synthesized $i lines"
