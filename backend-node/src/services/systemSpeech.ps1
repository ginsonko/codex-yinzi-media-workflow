param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
$ttsRequest = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$ttsSynth = $null
try {
    Add-Type -AssemblyName System.Speech
    $ttsSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $ttsVoices = @($ttsSynth.GetInstalledVoices() | Where-Object Enabled | ForEach-Object {
        [ordered]@{ name=$_.VoiceInfo.Name; language=$_.VoiceInfo.Culture.Name; gender=$_.VoiceInfo.Gender.ToString() }
    })
    if ($ttsRequest.voice) {
        $ttsMatch = @($ttsVoices | Where-Object { $_.name -ceq $ttsRequest.voice })
        if (!$ttsMatch.Count) { throw 'SPEECH_VOICE_UNAVAILABLE' }
        $ttsSynth.SelectVoice($ttsMatch[0].name)
    } elseif ($ttsRequest.language) {
        $ttsMatch = @($ttsVoices | Where-Object { $_.language -ieq $ttsRequest.language })
        if (!$ttsMatch.Count) {
            $ttsLanguage = $ttsRequest.language.Split('-')[0]
            $ttsMatch = @($ttsVoices | Where-Object { $_.language.Split('-')[0] -ieq $ttsLanguage })
        }
        if (!$ttsMatch.Count) { throw 'SPEECH_LANGUAGE_UNAVAILABLE' }
        $ttsSynth.SelectVoice($ttsMatch[0].name)
    }
    $ttsSynth.Rate = [int]$ttsRequest.rate
    $ttsSynth.Volume = [int]$ttsRequest.volume
    $ttsSynth.SetOutputToWaveFile($ttsRequest.wave_path)
    $ttsSynth.Speak([string]$ttsRequest.text)
    $ttsResult = [ordered]@{
        ok=$true; engine='System.Speech'; voice=$ttsSynth.Voice.Name
        language=$ttsSynth.Voice.Culture.Name; voices=$ttsVoices
    }
} catch {
    $ttsResult = [ordered]@{ ok=$false; code=$_.Exception.Message; voices=$ttsVoices }
} finally {
    if ($ttsSynth) { $ttsSynth.Dispose() }
}
[IO.File]::WriteAllText($ttsRequest.response_path, ($ttsResult | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
if (!$ttsResult.ok) { exit 1 }