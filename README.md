# Codex Desktop Infinite Agent

Companion durable para llevar Goals largos de Codex Desktop hasta un resultado verificable. No usa una API key, no invoca `codex exec`, no busca un `codex` instalado en `PATH` y no depende de sentinels de texto.

La interfaz de este companion es una consola, pero el trabajo se ejecuta como un Goal persistido de Codex Desktop. Inicia un sidecar separado con `codex.exe app-server` desde el bundle de Desktop; no puede conectarse a los pipes privados del proceso que ya abrió la ventana. Con el mismo usuario y `CODEX_HOME`, ambos comparten autenticación ChatGPT, threads y estado Goal, y el thread creado aparece en la aplicación. No usa el flujo de Codex CLI ni requiere instalarlo por separado.

## Inicio rápido

Requisitos: Windows x64, Codex Desktop con sesión ChatGPT iniciada, Git y Node.js 22 LTS.

```powershell
npm install
npm run build
npm link

codex-infinite doctor
codex-infinite run "Implementa la tarea, valida y crea los commits" --dir . --verify "npm test" --verify "npm run build"
```

El comando devuelve JSON con `runId`, `threadId`, estado, presupuestos, evidencia y snapshots Git. Usa el `runId` para consultar o reanudar:

```powershell
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
| `doctor` | Comprueba bundle, firma en Windows, App Server, sesión ChatGPT y acceso al store; no ejecuta un Goal. |

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

El texto del Goal debe tener entre 1 y 4000 caracteres.

`--verify` ejecuta secuencialmente cada comando suministrado por el usuario mediante el shell del host y fuera del sandbox de Codex. Comparten un máximo de 15 minutos o el tiempo restante de la corrida. El entorno usa únicamente herramientas machine-wide de Windows, Node.js, Git y .NET bajo `Program Files`; indica una ruta absoluta para otra herramienta confiable. No copies comandos de un repositorio no confiable.

Sin `--verify`, únicamente se ejecutan `git diff --check` y `git diff --cached --check`. Eso no compila, no corre tests, no cubre archivos untracked y no exige árbol limpio, commit ni push; añade checks explícitos para los criterios reales del proyecto.

Por seguridad, `resume` exige ejecutarse desde la raíz Git original (o recibirla otra vez con `--dir`) y no reutiliza autoridad persistida: debes volver a indicar `--verify`, `--network` y `--danger-full-access` cuando correspondan.

## Garantías

- Solo descubre el binario bundled de Codex Desktop en Windows x64, exige una firma Authenticode válida de OpenAI y no usa paquetes `codex` ajenos en `PATH`.
- Construye un entorno mínimo para el sidecar, excluye credenciales API y exige que `account/read` confirme autenticación `chatgpt`.
- Usa `approvalPolicy: never`, `workspaceWrite`, red deshabilitada y raíces absolutas por defecto.
- Rechaza aprobaciones, permisos adicionales, elicitaciones, preguntas interactivas y herramientas dinámicas; nunca autoaprueba.
- Configura las políticas del thread antes de activar el Goal y correlaciona todas las notificaciones por `threadId` y `turnId`.
- Persiste cada transición de forma atómica en `~/.codex/infinite-agent`, con journal JSONL y lock exclusivo por workspace.
- Fija y verifica por SHA-256 el Git machine-wide antes y después del trabajo; no confía en un `git.exe` inyectado en `PATH` por el workspace.
- Ejecuta App Server, Git y verificadores dentro de un Windows Job firmado por hash; el cierre cooperativo y la muerte del supervisor drenan también procesos descendientes.
- Tras un crash, pausa un Goal huérfano antes de reanudarlo y reconcilia el último turno persistido. Si su resultado es ambiguo, queda bloqueado en vez de duplicar acciones.
- Deja que la extensión Goal nativa provea `update_goal`, incluida su contabilidad de progreso; el supervisor nunca la reemplaza ni combina Goal nativo con `turn/start`.
- Si falla una verificación, inyecta diagnóstico acotado en el historial y reactiva el mismo Goal sin reemplazar el objetivo ni reiniciar su consumo.
- Refleja `active`, `paused`, `blocked`, `budgetLimited`, `usageLimited` y `complete` en el Goal nativo de Desktop.

## Modelo de terminación

Una corrida solo queda `completed` cuando Codex invoca la herramienta Goal nativa `update_goal complete`, el último turno queda durable, `thread/goal/get` sigue confirmando `complete`, pasan los checks Git y todos los `--verify`, se captura el snapshot Git final y se persiste el resultado antes de liberar el lock. Una solicitud de autoridad, un timeout, un límite o una verificación fallida nunca cuentan como éxito.

Los límites de turnos y tokens se aplican al cerrar un turno. Codex Desktop puede superar ligeramente un límite si el turno ya estaba en curso; el supervisor detiene el Goal inmediatamente al observarlo y nunca convierte ese exceso en éxito.

Los códigos de salida son `0` para completado, `1` para configuración/protocolo/runtime fallido, `2` para bloqueado, `3` para presupuesto agotado y `130` para pausa por señal.

Si no puede confirmarse el cierre de un proceso o del estado remoto, el lock queda en cuarentena dentro de `~/.codex/infinite-agent/locks`. Elimina únicamente ese archivo después de comprobar manualmente que no quedan procesos ni turnos activos; una reanudación normal no borra la cuarentena.

> No ejecutes el mismo thread simultáneamente en Codex Desktop y en este supervisor. Desktop usa pipes privados para su propio sidecar; este proyecto abre otro sidecar contra el mismo almacenamiento durable y no puede arbitrar un turno abierto en la ventana de Desktop.

## Compatibilidad

- Windows x64: integración probada con el bundle firmado de Codex Desktop `0.149.0-alpha.4`.
- macOS y Linux: no soportados; el guardia nativo de procesos falla cerrado antes de iniciar el App Server.

Las operaciones Goal requieren `experimentalApi` del App Server y pueden cambiar entre versiones de Desktop. `doctor` valida transporte y autenticación, no la ejecución completa de `thread/goal/*`. La CI de Windows usa mocks y no sustituye un smoke autenticado de Desktop. Antes de publicar debe repetirse, con cuota disponible, un smoke autenticado que confirme la exposición y ejecución end-to-end de la herramienta Goal nativa `update_goal`; la suite actual valida el protocolo y sus eventos con mocks. La versión `0.1.0` es privada y no está preparada para publicación npm.

## Desarrollo

```powershell
npm run check
```

La suite cubre activación Goal sin `turn/start`, eventos de `update_goal`, orden terminal/turno, políticas del thread, rechazos, estado atómico, locks, verificación, reparación, bloqueo y reconciliación tras crash. Consulta [SECURITY.md](SECURITY.md) antes de ampliar permisos.

Protocolo: [Codex App Server](https://learn.chatgpt.com/docs/app-server). Goals durables: [Long-running work](https://learn.chatgpt.com/docs/long-running-work).
