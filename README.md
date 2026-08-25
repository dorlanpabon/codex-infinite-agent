# Codex Desktop Infinite Agent

Companion durable para llevar Goals largos de Codex Desktop hasta un resultado verificable. No usa una API key, no invoca `codex exec`, no busca un `codex` instalado en `PATH` y no depende de sentinels de texto.

[![CI](https://github.com/dorlanpabon/codex-infinite-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/dorlanpabon/codex-infinite-agent/actions/workflows/ci.yml)

La interfaz principal es una aplicación de escritorio para Windows, macOS y Linux. El trabajo se ejecuta como un Goal persistido mediante el App Server incluido en Codex Desktop; no puede conectarse a los canales privados del proceso que ya abrió la ventana. Con el mismo usuario y `CODEX_HOME`, ambos comparten autenticación ChatGPT, threads y estado Goal, y el thread creado aparece en Codex Desktop. No usa el flujo de Codex CLI ni requiere instalarlo por separado.

## Descargas

La [página de releases](https://github.com/dorlanpabon/codex-infinite-agent/releases) publica instaladores nativos generados y comprobados en cada sistema operativo:

| Sistema | Arquitectura | Artefacto |
|---|---|---|
| Windows | x64 | `Codex-Infinite-<version>-windows-x64-Setup.exe` |
| macOS | Apple Silicon (arm64) e Intel (x64) | `Codex-Infinite-<version>-macos-<arch>.zip` |
| Debian/Ubuntu | x64 y arm64 | `Codex-Infinite-<version>-linux-<arch>.deb` |
| Fedora/RHEL | x64 y arm64 | `Codex-Infinite-<version>-linux-<arch>.rpm` |

La versión estable `0.7.0` se distribuye sin certificado comercial de Windows ni firma o notarización de Apple. SmartScreen o Gatekeeper pueden mostrar una advertencia. Comprueba siempre el archivo `SHA256SUMS.txt` de la release antes de instalar y no aceptes un binario obtenido fuera de GitHub Releases.

Cada artefacto y `SHA256SUMS.txt` incluye procedencia firmada por GitHub/Sigstore. Puedes verificarla con `gh attestation verify <archivo> -R dorlanpabon/codex-infinite-agent`; esto acredita el workflow y commit de origen, pero no reemplaza Authenticode ni la notarización de Apple.

El companion requiere que Codex Desktop esté instalado y que la sesión de ChatGPT esté iniciada. No incluye, copia ni solicita credenciales de OpenAI.

## Inicio rápido

Requisitos: Codex Desktop con sesión ChatGPT iniciada, Git del sistema y Node.js 22 LTS. Plataformas admitidas: Windows x64, macOS 14+ arm64/x64 y Linux x64/arm64 con el paquete oficial de Codex Desktop.

```sh
npm install
npm start
```

La aplicación comprueba Desktop y la sesión, permite elegir el workspace, crear o reanudar Goals, adjuntar archivos, pausarlos, revisar su progreso durable y consultar los threads compartidos. El editor no recorta el objetivo. Al reanudar, red, acceso total y comandos de verificación vuelven a valores seguros y deben autorizarse otra vez en el diálogo.

Cada corrida y sesión puede copiarse como `codex-infinite://run/<uuid>` o `codex-infinite://session/<thread-id>`. Abrir uno de estos enlaces en Windows, macOS o Linux solo enfoca la aplicación y selecciona la referencia; nunca inicia, reanuda ni pausa trabajo automáticamente. Las corridas pausadas, fallidas o bloqueadas se pueden reanudar explícitamente. **Ver contexto** consulta bajo demanda un resumen acotado de los mensajes recientes de usuario/asistente; ese contenido permanece solo en memoria mientras el diálogo está abierto y no se reinserta en el Goal.

El diálogo consulta `model/list` directamente al App Server autenticado, muestra solo los modelos disponibles para la cuenta y selecciona explícitamente el único `isDefault` nativo junto con su esfuerzo predeterminado. Al cambiar de modelo, el selector de esfuerzo se limita a sus valores admitidos. Si un App Server antiguo no ofrece el catálogo, el aviso no bloquea el objetivo: el campo vacío conserva la resolución nativa y cualquier ID escrito manualmente permanece intacto.

### Sesiones activas

La pestaña **Sesiones** muestra los threads persistidos de Codex Desktop junto con su estado de runtime, Goal y supervisor local. **Abrir en Codex** lleva directamente al thread mediante el enlace local de Codex Desktop. El interruptor **Continuar hasta terminar** activa directamente un Goal pausado. Si el thread todavía no tiene Goal, abre **Coloca el objetivo para activar** para escribir el objetivo y, si hace falta, adjuntar archivos. Si hay un turno manual activo, el companion solo lo observa y espera su estado `idle`; no activa el Goal ni envía mensajes por temporizador. Solo puede pausar una ejecución que esta instancia haya adoptado.

Los threads con un Goal activo ajeno, sin workspace válido o con estado incompatible se muestran como no disponibles y explican el motivo. Al crear un Goal faltante, el companion vuelve a comprobar thread y Goal inmediatamente antes de inyectar contexto y activarlo, y falla cerrado si detecta una carrera. El App Server no ofrece una creación condicional atómica, por lo que queda una ventana mínima inevitable entre la última lectura y `thread/goal/set`; no actives el mismo thread desde otra ventana al mismo tiempo. La actualización combina eventos del App Server con reconciliación de estado para evitar duplicar trabajo ante eventos perdidos.

### Objetivos y archivos

El objetivo no tiene un límite artificial en la aplicación. Como el campo `objective` del Goal nativo admite hasta 4000 caracteres, un objetivo más largo se conserva completo en el estado durable y se inyecta una sola vez en el historial antes de activar un Goal corto que apunta a ese contexto. Un estado de inyección ambiguo queda bloqueado y nunca se reintenta a ciegas.

El selector y la zona de arrastre admiten hasta 100 archivos locales por objetivo. Las rutas se resuelven de forma canónica, se deduplican y se comprueba que cada destino sea un archivo regular legible. Codex recibe una sola vez las rutas absolutas para leerlas con sus herramientas; este mecanismo no inicia un turno adicional ni envía continuaciones por intervalo.

## CLI avanzada

La consola sigue disponible para automatización y diagnóstico:

```sh
npm run build
npm link

codex-infinite doctor
codex-infinite run "Implementa la tarea, valida y crea los commits" --dir . --verify "npm test" --verify "npm run build"
```

La CLI devuelve JSON con `runId`, `threadId`, estado, presupuestos, evidencia y snapshots Git. Usa el `runId` para consultar o reanudar:

```sh
codex-infinite status <run-id>
codex-infinite resume <run-id> --dir . --verify "npm test" --verify "npm run build"
```

## Comandos

| Comando | Propósito |
|---|---|
| `run "objetivo"` | Crea un thread visible en Desktop y ejecuta el Goal. |
| `resume <run-id>` | Reconcilia y continúa una corrida propia sin repetir un turno ambiguo. |
| `status <run-id>` | Muestra todo el estado durable. |
| `runs` | Lista las corridas conocidas. |
| `threads` | Lista threads persistidos compartidos con Codex Desktop. |
| `doctor` | Comprueba bundle o paquete de Desktop, autenticidad del binario, App Server, sesión ChatGPT y acceso al store; no ejecuta un Goal. |

Opciones principales de `run`:

| Opción | Valor predeterminado |
|---|---|
| `--dir ruta` | Directorio actual; se normaliza a la raíz Git. |
| `--max-turns n` | `30` |
| `--max-hours n` | `8` |
| `--turn-minutes n` | `45` |
| `--token-budget n` | Sin límite explícito del companion; se respeta cualquier máximo configurado en Desktop. |
| `--verify "comando"` | Solo `git diff --check` y staged check; se puede repetir. |
| `--model id` / `--effort nivel` | Configuración de Codex Desktop. |
| `--network` | Red deshabilitada hasta habilitarla explícitamente. |
| `--danger-full-access` | Sandbox `workspace-write` hasta habilitarlo explícitamente. |
| `--bin ruta` | Override avanzado, restringido a una ruta dentro del bundle de Desktop. |

El objetivo debe contener al menos un carácter visible. No existe un máximo artificial del companion; los objetivos que superan el límite nativo se manejan como se describe en **Objetivos y archivos**.

Crear commits requiere autorizar `--danger-full-access` de forma explícita. El sandbox `workspaceWrite` puede modificar archivos del proyecto, pero no permite escribir dentro de `.git`; no concedas acceso total si el objetivo no necesita operaciones Git.

`--verify` ejecuta secuencialmente cada comando suministrado por el usuario mediante el shell del host y fuera del sandbox de Codex. Comparten un máximo de 15 minutos o el tiempo restante de la corrida. El entorno usa rutas de sistema confiables y excluye el workspace al resolver herramientas; indica una ruta absoluta para otra herramienta confiable. No copies comandos de un repositorio no confiable.

Sin `--verify`, únicamente se ejecutan `git diff --check` y `git diff --cached --check`. Eso no compila, no corre tests, no cubre archivos untracked y no exige árbol limpio, commit ni push; añade checks explícitos para los criterios reales del proyecto.

Por seguridad, `resume` exige ejecutarse desde la raíz Git original (o recibirla otra vez con `--dir`) y no reutiliza autoridad persistida: debes volver a indicar `--verify`, `--network` y `--danger-full-access` cuando correspondan.

## Garantías

- Solo descubre el binario incluido en Codex Desktop y no usa paquetes `codex` ajenos en `PATH`: valida Authenticode en Windows, firma y Team ID de OpenAI en macOS, y propiedad/permisos más integridad `dpkg` o `rpm` en Linux.
- Construye un entorno mínimo para el sidecar, excluye credenciales API y exige que `account/read` confirme autenticación `chatgpt`.
- Usa `approvalPolicy: never`, `workspaceWrite`, red deshabilitada y raíces absolutas por defecto.
- Rechaza aprobaciones, permisos adicionales, elicitaciones, preguntas interactivas y herramientas dinámicas; nunca autoaprueba.
- Configura las políticas del thread antes de activar el Goal y correlaciona todas las notificaciones por `threadId` y `turnId`.
- Persiste cada transición de forma atómica en `~/.codex/infinite-agent`, con journal JSONL y lock exclusivo por workspace.
- Fija y verifica por SHA-256 el Git del sistema antes y después del trabajo; no confía en un `git` inyectado en `PATH` por el workspace.
- En Windows ejecuta App Server, Git y verificadores dentro de un Job protegido por un wrapper fijado por hash; el cierre cooperativo y la muerte del supervisor drenan también procesos descendientes.
- En macOS y Linux usa grupos de procesos con `SIGTERM`/`SIGKILL` y confirma su drenaje durante un cierre normal. El sistema operativo no garantiza que el grupo se drene si el supervisor recibe `SIGKILL` o sufre un crash duro.
- Tras un crash, pausa un Goal huérfano antes de reanudarlo y reconcilia el último turno persistido. Si su resultado es ambiguo, queda bloqueado en vez de duplicar acciones.
- Deja que la extensión Goal nativa provea `update_goal`, incluida su contabilidad de progreso; el supervisor nunca la reemplaza ni combina Goal nativo con `turn/start`. El contexto inicial largo o con archivos usa `thread/inject_items`, que persiste contexto sin iniciar generación.
- Si falla una verificación, inyecta diagnóstico acotado en el historial y reactiva el mismo Goal sin reemplazar el objetivo ni reiniciar su consumo.
- Refleja `active`, `paused`, `blocked`, `budgetLimited`, `usageLimited` y `complete` en el Goal nativo de Desktop.

## Modelo de terminación

Una corrida solo queda `completed` cuando Codex invoca la herramienta Goal nativa `update_goal complete`, el último turno queda durable, `thread/goal/get` sigue confirmando `complete`, pasan los checks Git y todos los `--verify`, se captura el snapshot Git final y se persiste el resultado antes de liberar el lock. Una solicitud de autoridad, un timeout, un límite o una verificación fallida nunca cuentan como éxito.

Los límites de turnos y tokens se aplican al cerrar un turno. Codex Desktop puede superar ligeramente un límite si el turno ya estaba en curso; el supervisor detiene el Goal inmediatamente al observarlo y nunca convierte ese exceso en éxito.

Los códigos de salida son `0` para completado, `1` para configuración/protocolo/runtime fallido, `2` para bloqueado, `3` para presupuesto agotado y `130` para pausa por señal.

Si no puede confirmarse el cierre de un proceso o del estado remoto, el lock queda en cuarentena dentro de `~/.codex/infinite-agent/locks`. Elimina únicamente ese archivo después de comprobar manualmente que no quedan procesos ni turnos activos; una reanudación normal no borra la cuarentena.

> No envíes manualmente otro turno al mismo thread después de activar **Continuar hasta terminar**. El companion espera un turno manual que ya estuviera activo antes de adoptar el Goal, pero no puede impedir que otra ventana inicie trabajo concurrente después.

## Compatibilidad

- Windows x64: bundle firmado de Codex Desktop y aislamiento fuerte de descendientes mediante Windows Job. Exige Windows en `C:` y Git for Windows machine-wide bajo `C:\Program Files`.
- macOS 14+ arm64/x64: bundle firmado en `/Applications/ChatGPT.app`; cierre normal mediante grupo de procesos.
- Linux x64/arm64: paquete oficial instalado en `/usr/lib/chatgpt`; cierre normal mediante grupo de procesos.

Las operaciones Goal requieren `experimentalApi` del App Server y pueden cambiar entre versiones de Desktop. `doctor` valida transporte y autenticación, no la ejecución completa de `thread/goal/*`. La CI multiplataforma usa mocks y empaqueta la interfaz, pero no sustituye un smoke autenticado de Desktop. El 25 de agosto de 2026 pasó un smoke real autenticado de extremo a extremo: el Goal nativo llegó a `update_goal complete`, creó el commit solicitado con el árbol Git limpio y superó los comandos `--verify`. El paquete permanece privado para npm y se distribuye únicamente mediante instaladores de GitHub Releases.

## Desarrollo

```sh
npm run check
```

Empaquetado para el sistema anfitrión:

```sh
npm run desktop:package
npm run desktop:make
```

`desktop:package` crea la aplicación desempaquetada. `desktop:make` genera Squirrel en Windows, ZIP en macOS y paquetes DEB/RPM en Linux dentro de `out/`; no realiza compilación cruzada.

La suite cubre activación Goal sin `turn/start`, eventos de `update_goal`, orden terminal/turno, políticas del thread, rechazos, estado atómico, locks, verificación, reparación, bloqueo y reconciliación tras crash. La CI genera los instaladores y arranca la aplicación empaquetada en Windows x64, macOS arm64/x64 y Linux x64/arm64. Consulta [SECURITY.md](SECURITY.md) antes de ampliar permisos.

Protocolo: [Codex App Server](https://learn.chatgpt.com/docs/app-server). Goals durables: [Long-running work](https://learn.chatgpt.com/docs/long-running-work).
