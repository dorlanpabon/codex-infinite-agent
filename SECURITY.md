# Seguridad

Este documento define el contrato de seguridad del supervisor. Las capacidades aún no implementadas deben fallar cerrado; no deben simularse ni degradarse silenciosamente.

## Activos protegidos

- La autenticación de ChatGPT usada por Codex Desktop.
- Los threads compartidos y su historial.
- Los archivos y cambios no confirmados del workspace.
- El estado durable de cada corrida y su evidencia de verificación.
- La capacidad de ejecutar comandos, acceder a red o salir del workspace.

## Límites de confianza

- Solo se admiten Windows x64, macOS Apple Silicon y Linux x64/arm64. El sidecar debe pertenecer al bundle o paquete de Codex Desktop: se valida Authenticode de OpenAI en Windows, la firma y Team ID de OpenAI en macOS, y la propiedad/permisos junto con la integridad `dpkg` o `rpm` en Linux. Otras plataformas y binarios de `PATH` fallan cerrado.
- El sidecar se conecta por `stdio`. No se publica un puerto de control ni se aceptan clientes remotos.
- La autenticación pertenece a Codex Desktop. El supervisor no debe copiarla, persistirla ni escribirla en logs.
- El contenido del workspace, los prompts, la salida del modelo y los threads existentes se tratan como datos no confiables.

## Política de ejecución

Valores seguros por defecto:

| Control | Valor |
|---|---|
| Aprobaciones | `never` |
| Sandbox | `workspace-write` |
| Red | deshabilitada |
| Autoaprobación | nunca |

`--network` y `--danger-full-access` son ampliaciones explícitas. Deben quedar registradas en el estado de la corrida y mostrarse en su estado. Ningún prompt, Goal, thread o archivo del workspace puede activarlas.

Reanudar no reutiliza autoridad persistida: la interfaz restablece red, acceso total y comandos de verificación, y exige que el operador vuelva a seleccionarlos en el diálogo.

`--danger-full-access` elimina el límite normal del workspace. Antes de usarlo, revisa el repositorio, las instrucciones y las herramientas que Codex podría ejecutar.

Cada `--verify` se considera código proporcionado directamente por el operador: se ejecuta mediante el shell del host, fuera del sandbox de Codex y con un `PATH` mínimo de herramientas machine-wide. No uses comandos obtenidos de archivos o instrucciones no confiables y no incluyas secretos en la línea de comandos. Los scripts y dependencias del propio repositorio siguen siendo parte del artefacto evaluado; estos checks no son una atestación frente a código deliberadamente malicioso.

## Aislamiento y concurrencia

- Solo puede existir un supervisor cooperante por workspace cuando usa el mismo usuario y `CODEX_HOME`.
- El bloqueo y el estado durable deben permitir detectar propietario, recuperación y bloqueo obsoleto sin ejecutar dos veces el mismo turno.
- Reanudar debe reconciliar el último estado persistido con el thread antes de enviar otra instrucción.
- Liberar el bloqueo ocurre después de persistir el resultado terminal.
- Un cierre incierto conserva metadatos de cuarentena y bloquea nuevas corridas hasta revisión manual.

> **No reanudes un thread en Codex Desktop mientras este supervisor lo controla.** Los threads son compartidos; la concurrencia puede duplicar comandos, mezclar respuestas y producir una finalización incorrecta.

El lock no arbitra la ventana de Desktop, procesos que usen otro `CODEX_HOME` ni actores no cooperantes. Los modos `0600`/`0700` se solicitan al sistema de archivos, pero en Windows la protección efectiva también depende de las ACL heredadas del perfil.

La interfaz Electron carga únicamente recursos locales mediante un protocolo propio. El renderer mantiene `nodeIntegration` deshabilitado, `contextIsolation` y sandbox habilitados, una CSP restrictiva, IPC con canales y payloads validados, y deniega navegación, nuevas ventanas, webviews y permisos. No se debe añadir contenido remoto ni exponer primitivas genéricas de filesystem, shell o IPC al renderer.

## Terminación segura

No se usan sentinels ni coincidencias de texto como prueba de éxito. La terminación requiere conjuntamente:

- llamada de Codex a la herramienta Goal nativa `update_goal`, con contabilidad de progreso del runtime;
- estado nativo de Goal `complete` y último turno durable;
- verificación independiente en el host;
- snapshot Git final y persistencia durable del resultado y de su evidencia.

Una corrida bloqueada, una solicitud de permisos, una pérdida del sidecar o una verificación fallida deben conservarse como estados no exitosos.

En Windows, el sidecar y cada proceso host se ejecutan bajo un Windows Job con `KILL_ON_JOB_CLOSE`. El wrapper espera que todos los procesos del Job terminen antes de confirmar su salida; al recuperar metadatos de un propietario caído, el lock respeta una ventana de drenaje antes de permitir otra corrida.

En macOS y Linux, cada proceso administrado inicia un grupo independiente. El supervisor envía `SIGTERM`, escala a `SIGKILL` y confirma el drenaje del grupo durante el cierre normal. A diferencia del Windows Job, este mecanismo no puede garantizar la terminación de descendientes si el propio supervisor recibe `SIGKILL` o sufre un crash duro; la recuperación debe tratar cualquier cierre incierto como cuarentena y exigir revisión manual.

## Registro y datos sensibles

El estado guarda el objetivo completo, errores y salida acotada de verificación. El journal incluye identificadores, transiciones y resúmenes de checks. La redacción de secretos es heurística: no incluyas credenciales ni datos sensibles en objetivos, comandos o salidas de verificación.

El entorno del sidecar se construye con una allowlist que excluye credenciales API conocidas y otras variables no requeridas. Esto reduce exposición accidental, pero no convierte el workspace ni la salida de herramientas en datos confiables.

La salida no confiable debe estructurarse o sanearse antes de mostrarse para evitar que secuencias de control falsifiquen el terminal o los logs.

## Reporte de vulnerabilidades

No publiques credenciales, datos de threads ni una explotación reproducible en un issue público. Usa el canal privado de seguridad del repositorio cuando esté disponible e incluye impacto, condiciones, versión y una reproducción mínima sin secretos.
