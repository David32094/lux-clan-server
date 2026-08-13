$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$assetsRoot = Split-Path -Parent $projectRoot

$copies = @(
  @{
    Source = Join-Path $assetsRoot 'INTEGRANTES\ChatGPT Image 30 jul 2026, 06_50_53 p.m..png'
    Target = Join-Path $projectRoot 'INTEGRANTES\fluxo-integrantes.png'
  },
  @{
    Source = Join-Path $assetsRoot 'ENFRETAMIENTOS\Picsart_26-07-31_07-02-08-694.jpg'
    Target = Join-Path $projectRoot 'ENFRETAMIENTOS\fluxo-enfrentamientos.jpg'
  },
  @{
    Source = Join-Path $assetsRoot 'ENFRETAMIENTOS\OVERLAY POR ENCIMA DE LA FOTO DEL RESULTADO.png'
    Target = Join-Path $projectRoot 'ENFRETAMIENTOS\fluxo-result-overlay.png'
  },
  @{
    Source = Join-Path $assetsRoot 'ICONOS\ChatGPT Image 28 jul 2026, 13_49_07.png'
    Target = Join-Path $projectRoot 'ICONOS\FLUXO_LOGO.png'
  }
)

foreach ($copy in $copies) {
  if (-not (Test-Path -LiteralPath $copy.Source)) {
    throw "No existe el recurso FLUXO requerido: $($copy.Source)"
  }
  $targetDirectory = Split-Path -Parent $copy.Target
  New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
  Copy-Item -LiteralPath $copy.Source -Destination $copy.Target -Force
}

Write-Host 'Recursos oficiales FLUXO sincronizados con el sitio.'
