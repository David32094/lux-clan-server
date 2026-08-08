#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════
  INYECTOR DE CONFIGURACIONES PARA LUX CLAN EDITOR
═══════════════════════════════════════════════════════════════

Este script lee los archivos JSON de configuraciones exportadas
y los inyecta directamente en el HTML del editor.

Cuando un usuario de Android/iPhone abra el archivo HTML,
las configuraciones estarán precargadas automáticamente
en localStorage SIN necesidad de importar nada manualmente.

USO:
  python inyectar_configs.py

  Esto genera: LUX_CLAN_EDITOR_CON_CONFIGS.html
"""

import json
import os
import sys

# ── Rutas ──
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
HTML_INPUT = os.path.join(SCRIPT_DIR, "LUX_CLAN_EDITOR.html")
HTML_OUTPUT = os.path.join(SCRIPT_DIR, "LUX_CLAN_EDITOR_CON_CONFIGS.html")
CONFIGS_DIR = os.path.join(SCRIPT_DIR, "configuraciones")

INTEG_JSON = os.path.join(CONFIGS_DIR, "LUX CLAN_PRESETS_INTEGRANTES.json")
ENFRENT_JSON = os.path.join(CONFIGS_DIR, "LUX CLAN_PRESETS_ENFRENTAMIENTOS.json")

# Storage keys del editor LUX CLAN
LS_KEY_INTEG = "lux_banner_configs_v2"
LS_KEY_ENFRENT = "lux_enfrentamientos_configs_v2"


def load_json_file(path):
    """Carga un archivo JSON y devuelve su contenido como string formateado."""
    if not os.path.exists(path):
        print(f"⚠️  Archivo no encontrado: {path}")
        return None
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    # Contar presets
    names = [k for k in data.keys() if k != "PREDETERMINADO"]
    print(f"  ✅ {len(names)} preset(s) encontrado(s): {', '.join(names)}")
    return json.dumps(data, ensure_ascii=False)


def build_preload_script(integ_json_str, enfrent_json_str):
    """Genera el bloque <script> que precarga las configs en localStorage."""
    script = """
<!-- ═══════════════════════════════════════════════════════════
     CONFIGURACIONES PRECARGADAS (para usuarios Android/iPhone)
     Este bloque inyecta las configuraciones directamente en
     localStorage antes de que el editor se inicialice.
     Los usuarios reciben el editor con configs listas.
═══════════════════════════════════════════════════════════ -->
<script>
(function() {
  'use strict';
"""

    if integ_json_str:
        script += f"""
  // ── PRESETS DE INTEGRANTES ──
  var PRESETS_INTEG = {integ_json_str};
  try {{
    var cur = JSON.parse(localStorage.getItem('{LS_KEY_INTEG}') || '{{}}');
    var added = false;
    Object.keys(PRESETS_INTEG).forEach(function(n) {{
      cur[n] = PRESETS_INTEG[n]; added = true;
    }});
    if (added) localStorage.setItem('{LS_KEY_INTEG}', JSON.stringify(cur));
  }} catch(e) {{}}
"""

    if enfrent_json_str:
        script += f"""
  // ── PRESETS DE ENFRENTAMIENTOS ──
  var PRESETS_ENFRENT = {enfrent_json_str};
  try {{
    var cur2 = JSON.parse(localStorage.getItem('{LS_KEY_ENFRENT}') || '{{}}');
    var added2 = false;
    Object.keys(PRESETS_ENFRENT).forEach(function(n) {{
      cur2[n] = PRESETS_ENFRENT[n]; added2 = true;
    }});
    if (added2) localStorage.setItem('{LS_KEY_ENFRENT}', JSON.stringify(cur2));
  }} catch(e) {{}}
"""

    script += """
  console.log('✅ Configuraciones del clan precargadas');
})();
<\\/script>
"""
    # Fix: el cierre de script no puede tener escape dentro del heredoc
    script = script.replace("<\\/script>", "</script>")
    return script


def inject_into_html(html_content, preload_script):
    """Inyecta el script de precarga justo antes del <script> principal del editor."""
    # Buscamos el primer <script> que contiene el código del editor
    # (el que está después del toast div)
    marker = '<div id="toast"></div>'
    
    if marker not in html_content:
        # Intentar con variaciones de encoding
        marker = '<div id="toast"></div>'
    
    if marker in html_content:
        # Insertamos nuestro script justo después del toast div y antes del script principal
        parts = html_content.split(marker, 1)
        return parts[0] + marker + "\n" + preload_script + "\n" + parts[1]
    else:
        # Fallback: inyectar antes del primer <script> del body
        # Buscar la etiqueta </footer> que está justo antes
        fallback_marker = "<script>"
        # Encontrar la última ocurrencia antes del código JS principal
        idx = html_content.find("const INTEG_TEMPLATE")
        if idx > 0:
            # Buscar el <script> que contiene eso
            script_start = html_content.rfind("<script>", 0, idx)
            if script_start > 0:
                return (
                    html_content[:script_start]
                    + preload_script + "\n"
                    + html_content[script_start:]
                )
        
        print("❌ No se pudo encontrar punto de inyección en el HTML")
        sys.exit(1)


def main():
    print("═" * 60)
    print("  INYECTOR DE CONFIGURACIONES - LUX CLAN EDITOR")
    print("═" * 60)
    print()

    # Verificar que existe el HTML
    if not os.path.exists(HTML_INPUT):
        print(f"❌ No se encontró: {HTML_INPUT}")
        sys.exit(1)

    # Cargar configuraciones
    print("📂 Cargando configuraciones...")
    print(f"  📄 Integrantes: {INTEG_JSON}")
    integ = load_json_file(INTEG_JSON)

    print(f"  📄 Enfrentamientos: {ENFRENT_JSON}")
    enfrent = load_json_file(ENFRENT_JSON)

    if not integ and not enfrent:
        print("\n❌ No se encontraron configuraciones para inyectar.")
        sys.exit(1)

    # Construir script de precarga
    print("\n🔧 Generando script de precarga...")
    preload = build_preload_script(integ, enfrent)

    # Leer HTML original
    print(f"📖 Leyendo: {HTML_INPUT}")
    with open(HTML_INPUT, "r", encoding="utf-8") as f:
        html = f.read()

    # Inyectar
    print("💉 Inyectando configuraciones en el HTML...")
    html_modified = inject_into_html(html, preload)

    # Guardar
    with open(HTML_OUTPUT, "w", encoding="utf-8") as f:
        f.write(html_modified)

    size_mb = os.path.getsize(HTML_OUTPUT) / (1024 * 1024)
    print(f"\n✅ ¡LISTO! Archivo generado:")
    print(f"   📁 {HTML_OUTPUT}")
    print(f"   📏 Tamaño: {size_mb:.1f} MB")
    print()
    print("═" * 60)
    print("  INSTRUCCIONES:")
    print("  1. Enviá el archivo 'LUX_CLAN_EDITOR_CON_CONFIGS.html'")
    print("     a tus usuarios de Android/iPhone")
    print("  2. Al abrirlo, las configuraciones ya estarán")
    print("     precargadas automáticamente ✅")
    print("  3. Los usuarios pueden modificarlas y guardar nuevas")
    print("═" * 60)


if __name__ == "__main__":
    main()
