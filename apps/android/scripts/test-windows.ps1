param([ValidateSet("engine", "ffi", "cli")][Parameter(Mandatory = $true)][string]$Phase)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if (![Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
    throw "Actual Windows validation requires a Windows host"
}
$nativeRoot = Split-Path $PSScriptRoot -Parent
$repositoryRoot = Split-Path (Split-Path $nativeRoot -Parent) -Parent
if (!$env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $env:TEMP "opensesame-native-target" }

$reportRoot = Join-Path $env:CARGO_TARGET_DIR "native-reports"
New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null

function Invoke-NativeTool([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable failed with exit code $LASTEXITCODE" }
}

function Invoke-NativeTests([string]$Group, [string[]]$Arguments) {
    $log = Join-Path $reportRoot "$Group.log"
    $env:CARGO_TERM_COLOR = "never"
    & cargo @Arguments 2>&1 | Tee-Object -FilePath $log
    if ($LASTEXITCODE -ne 0) { throw "Native Rust tests failed: $Group" }
    & python (Join-Path $nativeRoot "scripts/verify-native-results.py") rust $log --group $Group |
        Out-File -FilePath (Join-Path $reportRoot "$Group-verified.json") -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw "Native Rust execution proof failed: $Group" }
}

Push-Location $repositoryRoot
try {
    if ($Phase -eq "engine") {
        Invoke-NativeTests "retired" @("+1.88.0", "test", "--locked", "-p", "opensesame-human-vault", "retired_credentials::")
        Invoke-NativeTests "canaries" @("+1.88.0", "test", "--locked", "-p", "opensesame-human-vault", "--lib", "credential_canaries::")
        Invoke-NativeTests "windows-library" @("+1.88.0", "test", "--locked", "-p", "opensesame-human-vault", "--lib", "windows_")
        Invoke-NativeTests "windows-storage" @("+1.88.0", "test", "--locked", "-p", "opensesame-human-vault", "--test", "windows_storage", "--", "--nocapture")
        Invoke-NativeTests "authenticator" @("+1.88.0", "test", "--locked", "-p", "opensesame-authenticator-core", "--features", "ffi")
        Invoke-NativeTests "windows-retired-refusal" @("+1.88.0", "test", "--locked", "-p", "opensesame-sealed-store", "--test", "retired_credentials_windows", "--", "--nocapture")
        Invoke-NativeTests "windows-common-key" @("+1.88.0", "test", "--locked", "-p", "opensesame-sealed-store", "--test", "windows_store_boundary", "--", "--nocapture")
    } elseif ($Phase -eq "ffi") {
        Invoke-NativeTool "cargo" @("+1.88.0", "build", "--locked", "-p", "opensesame-authenticator-core", "--features", "ffi")
        $nativeDll = Join-Path $env:CARGO_TARGET_DIR "debug/opensesame_authenticator_core.dll"
        if (!(Test-Path $nativeDll)) { throw "Actual MSVC Rust FFI library was not built" }
        $generated = Join-Path $nativeRoot "generated/kotlin"
        Invoke-NativeTool "cargo" @("+1.88.0", "run", "--locked", "-p", "opensesame-authenticator-core", "--features", "bindgen", "--bin", "uniffi-bindgen", "--", "generate", $nativeDll, "--language", "kotlin", "--out-dir", $generated, "--no-format")
        foreach ($file in Get-ChildItem $generated -Recurse -Filter "*.kt") {
            $text = [IO.File]::ReadAllText($file.FullName).Replace("`r`n", "`n")
            $text = [regex]::Replace($text, "[ \t]+$", "", [Text.RegularExpressions.RegexOptions]::Multiline)
            [IO.File]::WriteAllText($file.FullName, $text.TrimEnd([char[]]"`r`n") + "`n", [Text.UTF8Encoding]::new($false))
        }
        Invoke-NativeTool "git" @("diff", "--exit-code", "--", "apps/android/generated/kotlin")
        $env:OPENSESAME_NATIVE_HOST_LIBRARY_DIR = Join-Path $env:CARGO_TARGET_DIR "debug"
        Push-Location (Join-Path $nativeRoot "android")
        try {
            & gradle.bat --no-daemon --max-workers=2 :app:testDebugUnitTest 2>&1 |
                Tee-Object -FilePath (Join-Path $reportRoot "windows-gradle.log")
            if ($LASTEXITCODE -ne 0) { throw "Generated Windows FFI JVM tests failed" }
        }
        finally { Pop-Location }
        Get-FileHash $nativeDll -Algorithm SHA256 | ConvertTo-Json |
            Out-File -FilePath (Join-Path $reportRoot "windows-ffi-build.json") -Encoding utf8
        $jvmReports = Join-Path $nativeRoot "android/app/build/test-results/testDebugUnitTest"
        & python (Join-Path $nativeRoot "scripts/verify-native-results.py") jvm $jvmReports |
            Out-File -FilePath (Join-Path $reportRoot "windows-jvm-verified.json") -Encoding utf8
        if ($LASTEXITCODE -ne 0) { throw "Native Windows JVM execution proof failed" }
        Copy-Item -Path (Join-Path $jvmReports "TEST-*.xml") -Destination $reportRoot
    } else {
        Invoke-NativeTool "cargo" @("+1.88.0", "build", "--locked", "-p", "opensesame-cli", "--bin", "opensesame")
        $cli = Join-Path $env:CARGO_TARGET_DIR "debug/opensesame.exe"
        if (!(Test-Path $cli)) { throw "Actual MSVC CLI executable is missing" }
        Get-FileHash $cli -Algorithm SHA256 | ConvertTo-Json |
            Out-File -FilePath (Join-Path $reportRoot "windows-cli-build.json") -Encoding utf8
    }
} finally { Pop-Location }
