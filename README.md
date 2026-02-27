# Printer UI - Fast Connect

Interfaz local para diagnosticar por qué una impresora Wi-Fi tarda en empezar a imprimir y para mantener la conexión "caliente" con probes periódicos.

Pensado para tu caso de **HP Deskjet 2800 series (F422CE)**, pero funciona con otras impresoras en red.

## Qué hace

- Mide latencia de resolución DNS del host de impresora.
- Ejecuta `ping` para detectar latencia/pérdida de paquetes.
- Prueba puertos comunes de impresión: `631`, `9100`, `80`, `443`.
- Genera recomendaciones automáticas según resultados.
- Autodetecta colas de impresión CUPS y autocompleta host/cola.
- Carga opciones de impresión desde la cola: orientación, tamaño, color, bandeja y dúplex.
- Consulta estado de papel (SNMP + fallback por alertas de CUPS).
- Permite subir archivo y enviarlo a imprimir desde la UI.
- Incluye modo **Fast Path**:
  - Hace probes periódicos para ayudar a que la impresora no entre en suspensión profunda.
  - Reduce la lentitud del "primer trabajo" en algunos entornos.

## Requisitos

- Node.js `>= 18`
- Estar en la misma red local que la impresora.
- Para estado de papel: `snmpwalk` instalado (opcional, sin esto verás estado "desconocido").
- Para imprimir desde UI:
  - Linux/macOS: `lp` o `lpr`
  - Windows: PowerShell disponible
  - Para forzar B/N real en PDF (preconversión): `ghostscript` (`gs`) opcional
  - Fallback automático `RAW 9100` solo para trabajos pre-renderizados compatibles (`.prn`, `.pcl`, `.pclm`, `.ps`, `.txt`)

## Uso

```bash
npm start
```

Abrir:

```text
http://localhost:3210
```

## Flujo recomendado

1. Obtener IP actual de la impresora (desde router, app HP Smart o panel de red).
2. Correr diagnóstico con esa IP.
3. Si DNS sale lento, usar IP fija/manual en tu sistema de impresión.
4. Activar Fast Path con intervalo de 20-30 segundos.
5. Presionar `Autodetectar` para llenar cola y host desde CUPS.
6. Revisar estado de papel con `Revisar Papel`.
7. En `Impresión Directa`, elegir opciones y enviar archivo.
8. Probar impresión real (1ra y 2da página) y comparar tiempos.

## Notas técnicas

- Esta herramienta **no reemplaza** el driver/spooler del sistema.
- Si envías PDF y no tienes `lp/lpr`, la app mostrará error para evitar "falsos envíos" sin impresión real.
- En algunos modelos (como Deskjet 2800), SNMP puede devolver estados vendor `-2/-3`; se usa CUPS como segunda fuente.
- Si sigues con mucha demora aunque la red esté bien, el cuello de botella suele estar en:
  - spooler de Windows/macOS,
  - driver HP Smart,
  - cola de impresión retenida por servicios del sistema.
