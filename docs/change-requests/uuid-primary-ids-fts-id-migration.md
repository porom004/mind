# Change Request: UUIDs primarios reales y migración de `fts_id` numérico

**Estado:** propuesto  
**Fecha:** 2026-06-03  
**Repositorio:** `mind`  
**Tipo:** cambio de arquitectura y persistencia  
**Ruta:** `docs/change-requests/uuid-primary-ids-fts-id-migration.md`

## Resumen

Este Change Request define la migración de `mind` desde IDs numéricos locales como identidad primaria de memorias hacia UUIDs como IDs primarios reales. El cambio mantiene un identificador numérico local, `fts_id`, exclusivamente para SQLite FTS5, porque FTS5 depende de un `rowid` entero.

La motivación principal es eliminar colisiones entre instalaciones, especialmente en autosync, sin romper los contratos públicos basados en nombres y referencias. El contrato MCP permanece basado en `space/name` y referencias nominales; la web puede ajustar su consumo interno cuando lo necesite.

## Contexto

El schema actual usa `memories.id INTEGER PRIMARY KEY AUTOINCREMENT` como identidad principal. Ese valor funciona dentro de una base local, pero no es una identidad estable entre máquinas. En autosync, dos bases distintas pueden crear memorias con el mismo ID numérico y asociar entradas del manifest con memorias incorrectas.

También existe una restricción técnica: SQLite FTS5 usa `rowid` entero para su índice. La investigación validó que usar UUIDs de texto como `rowid` o como `content_rowid` no es una base segura. Por eso el diseño separa la identidad lógica de la identidad técnica de búsqueda.

## Decisiones confirmadas

Las siguientes decisiones están confirmadas y forman parte del contrato de este cambio:

1. Se acepta una tabla de secuencia para asignar `fts_id`.
2. `logs.id` permanece numérico.
3. Los payloads JSON históricos dentro de logs permanecen con formato legacy. Los nuevos logs usan UUIDs donde corresponda.
4. El contrato MCP no cambia. Sigue basado en nombres y referencias; la web puede ajustar su uso interno cuando sea necesario.
5. Se acepta `manifest` versión 3 para autosync.
6. Se normaliza `memories` por `space_id` si los contratos MCP y CLI se preservan.

## Alcance

Este cambio cubre la identidad persistente de espacios, memorias y relaciones internas que hoy dependen del ID numérico de memoria.

En alcance:

- Convertir `spaces` a UUID primario real y mantener `spaces.name` como clave pública única.
- Convertir `memories.id` a UUID primario real.
- Añadir `memories.fts_id INTEGER UNIQUE NOT NULL` como identificador técnico local para FTS5.
- Normalizar `memories.space_id` contra `spaces.id`.
- Migrar tablas dependientes de memoria para referenciar UUIDs.
- Mantener `logs.id` como `INTEGER PRIMARY KEY AUTOINCREMENT`.
- Emitir nuevos logs con UUIDs donde los payloads referencien memorias o espacios.
- Mantener compatibilidad de lectura para logs históricos.
- Migrar autosync a `manifest` versión 3.
- Preservar contratos CLI y MCP basados en nombres, referencias y `space/name`.

Fuera de alcance:

- Cambiar el contrato MCP público a IDs UUID.
- Eliminar soporte de lectura para manifests v2 durante la migración.
- Reescribir el sistema de logs histórico.
- Cambiar el modelo público de referencias `space/name`.
- Cambiar la semántica de búsqueda, ranking o RAG fuera de lo necesario para mapear `fts_id` a UUID.
- Cambiar `logs.id` a UUID.

## Diseño propuesto

### Identidad de espacios

`spaces` debe usar un UUID como clave primaria real y conservar `name` como identificador público único.

Modelo propuesto:

- `spaces.id TEXT PRIMARY KEY`
- `spaces.name TEXT NOT NULL UNIQUE`
- `spaces.description TEXT NOT NULL DEFAULT ''`
- `spaces.hidden INTEGER NOT NULL DEFAULT 0`
- timestamps existentes

Las rutas CLI, MCP y API que reciben un espacio por nombre siguen aceptando el nombre. Internamente, los repositorios resuelven `space.name` a `space.id` antes de operar sobre memorias.

### Identidad de memorias

`memories.id` pasa a ser UUID textual. `memories.fts_id` queda como entero local estable dentro de una base SQLite concreta.

Modelo propuesto:

- `memories.id TEXT PRIMARY KEY`
- `memories.fts_id INTEGER NOT NULL UNIQUE`
- `memories.space_id TEXT NOT NULL REFERENCES spaces(id)`
- `memories.name TEXT NOT NULL`
- `UNIQUE(space_id, name)`
- columnas existentes de contenido, tier, pinned, embedding y timestamps

`fts_id` no es identidad pública, no se exporta como identidad de sync, y no se usa para resolver contratos MCP o CLI.

### Secuencia de `fts_id`

Se debe crear una tabla de secuencia para asignar `fts_id` de forma explícita y transaccional.

Forma recomendada:

- `fts_id_sequence.entity TEXT PRIMARY KEY`
- `fts_id_sequence.next_value INTEGER NOT NULL`

Fila inicial:

- `entity = 'memories'`
- `next_value = max(memories.fts_id) + 1`

La asignación de `fts_id` debe ocurrir dentro de la misma transacción que crea la memoria. Esto evita depender de `AUTOINCREMENT` como identidad primaria y deja claro que `fts_id` solo existe para FTS5.

### FTS5

`memories_fts` debe seguir usando `rowid` entero. La relación pasa a ser:

- `memories.fts_id` ↔ `memories_fts.rowid`
- `memories.id` queda como UUID lógico
- las consultas FTS devuelven `rowid`, y el repositorio lo une contra `memories.fts_id`

Las operaciones de inserción, actualización y borrado del índice deben usar `fts_id`, no `id`.

### Tags y links

Las tablas dependientes deben referenciar UUIDs:

- `memory_tags.memory_id TEXT REFERENCES memories(id)`
- `links.source_id TEXT REFERENCES memories(id)`
- `links.target_id TEXT REFERENCES memories(id)`

Los nombres de columna pueden conservarse para minimizar el cambio, pero el tipo y las expectativas del código pasan de `number` a `string`.

### Logs

`logs.id` permanece numérico.

No se migran payloads históricos en `input_data`, `output_data` o `caller_info`. Esos JSON pueden contener IDs numéricos legacy y deben seguir siendo legibles como evidencia histórica.

A partir de este cambio, los nuevos logs que incluyan referencias a memorias o espacios deben usar UUIDs donde aplique. Cuando el evento sea público y esté basado en nombre o referencia, puede seguir registrando `space`, `name` o `ref`.

### MCP y CLI

El contrato MCP no cambia. Las herramientas siguen aceptando y devolviendo referencias por nombre donde esa sea la semántica actual.

Reglas:

- No introducir UUIDs como requisito para usar MCP.
- No eliminar `space/name` ni `resolveMemoryRef`.
- Preservar lectura, enlaces y checkpoints por referencia nominal.
- Si un payload interno necesita ID, usar UUID internamente sin hacerlo contrato público.

CLI conserva la misma experiencia de usuario. Los comandos que internamente resuelven memoria por ID deben cambiar a UUID sin exponerlo como argumento nuevo.

### API y web

La API puede devolver UUIDs en campos `id` si hoy devuelve IDs numéricos. La web puede adaptarse a UUIDs para nodos, selección de memoria, paneles y mapa neural.

El contrato de URL de la SPA sigue basado en espacio y memoria por nombre:

- `/`
- `/spaces/{encodedSpace}?view=list|map&memory={encodedMemory?}`

No se requiere cambiar el deep link público a UUID.

### Autosync manifest v3

Autosync debe migrar de manifest v2 a v3.

Objetivo de v3:

- Usar UUID como identidad estable de memoria.
- Mantener el nombre como dato humano y como contrato público.
- Evitar usar IDs numéricos locales como clave principal del manifest.
- Mantener lectura de v2 para migrar espacios existentes.

Forma propuesta de entry:

- `memory_id`: UUID estable de la memoria.
- `memory_name`: nombre actual.
- `path`: archivo administrado.
- `legacy_numeric_id`: opcional, solo para lectura/migración desde v2.
- hashes de contenido y metadata existentes.
- timestamps UTC existentes.
- campos de tombstone existentes.

Las claves de `entries` deben basarse en UUID, por ejemplo `uuid:{memory_id}`. Durante lectura de v2, si solo existe `memory_id` numérico, el importador debe tratarlo como hint local y resolver por nombre cuando sea necesario.

### Migración de directorios autosync

Autosync también debe migrar la ubicación física de cada espacio sincronizado. El formato actual usa directorios derivados del nombre público del espacio, `.mind/spaces/<hash(space_name)>/`. El formato v3 debe usar el UUID del espacio como directorio canónico: `.mind/spaces/<space_id>/`.

Reglas de migración:

- Detectar directorios legacy por el hash del `space_name` al leer la configuración de sync y el manifest v2.
- Resolver el `space_id` del espacio antes de escribir o actualizar el manifest v3.
- Mover o copiar el directorio legacy a `.mind/spaces/<space_id>/` de forma segura antes de la siguiente exportación controlada.
- Actualizar o leer el manifest como v3 después de que la ruta canónica exista.
- Si el directorio destino ya existe y su contenido es compatible con el manifest legacy, reutilizarlo sin duplicar archivos.
- Si el destino ya existe con contenido incompatible, abortar la migración de ese espacio y reportar el conflicto en vez de hacer un merge destructivo.
- Mantener la lectura de v2 durante la transición para que una instalación existente pueda recuperarse sin perder archivos administrados.

## Estrategia de migración

La migración debe ser transaccional y protegida por el mecanismo existente de backup y validación de migraciones.

### Seguridad de backup, rollback y arranque

La migración automática debe ejecutarse durante la inicialización del store cuando una base existente esté desactualizada. Esto aplica a cualquier superficie que abra el store: CLI, servidor MCP y servidor web/API.

Flujo requerido:

1. Detectar `schema_version` al arrancar.
2. Si la base está en una versión anterior, crear un backup con el mecanismo existente de migration safety antes de modificar datos.
3. Ejecutar la migración v8 dentro del flujo transaccional de migraciones.
4. Validar el resultado con `PRAGMA quick_check`, `PRAGMA foreign_key_check`, unicidad de `fts_id`, consistencia de referencias UUID y consistencia FTS.
5. Si la migración o la validación falla, restaurar el backup, abortar el arranque y devolver un error claro al proceso llamador.
6. Si la validación pasa, completar el arranque normal de CLI, MCP o web/API con la base ya migrada.

Ningún modo de ejecución debe continuar con una base parcialmente migrada. La restauración automática del backup es obligatoria ante fallos de migración o validación.

Pasos esperados:

1. Crear tablas nuevas con UUIDs y `fts_id`.
2. Generar UUIDs para espacios existentes.
3. Generar UUIDs para memorias existentes.
4. Copiar memorias preservando el ID numérico legacy como `fts_id`.
5. Migrar `space_name` a `space_id`.
6. Migrar tags y links desde IDs numéricos hacia UUIDs.
7. Reconstruir `memories_fts` usando `fts_id` como `rowid`.
8. Crear e inicializar `fts_id_sequence`.
9. Preservar `logs` sin cambiar `logs.id` ni reescribir JSON histórico.
10. Validar `PRAGMA quick_check`, `PRAGMA foreign_key_check`, unicidad de `fts_id`, y consistencia FTS.
11. Actualizar `schema_version`.

La migración no debe modificar el significado de `created_at`, `updated_at` ni `changed_at`.

## Impacto por superficie

### Store y repositorios

Las interfaces TypeScript deben cambiar de `number` a `string` donde representen IDs primarios de memoria. Las operaciones técnicas de FTS deben aceptar `fts_id: number`.

Superficies esperadas:

- `src/types.ts`
- `src/store/mind-store.ts`
- `src/store/schema.ts`
- `src/store/repositories/*`
- `src/store/shared/fts-helpers.ts`
- `src/store/shared/validation-helpers.ts`

### Búsqueda

Las consultas FTS deben devolver resultados con `id` UUID. El `rowid` de FTS no debe filtrarse como identidad pública.

### Checkpoints

Los checkpoints y recovery packs deben preservar referencias por nombre y usar UUID internamente cuando resuelvan memorias enlazadas.

### Sync

Autosync debe escribir manifest v3 y leer v2. El flujo de import/export debe dejar de confiar en IDs numéricos locales como identidad estable.

Superficies esperadas:

- `src/sync/manifest.ts`
- `src/sync/types.ts`
- `src/sync/file-sync-service.ts`
- `src/sync/importer.ts`
- `src/sync/status-diagnostics.ts`
- `src/sync/conflict-resolver.ts`

### API y web

La web debe tratar IDs como strings. El mapa neural debe aceptar nodos con UUID. Las URLs públicas siguen basadas en nombres.

### Tests

Los tests deben cubrir migración, store, FTS, MCP, API, sync y web. Deben incluir casos donde IDs numéricos colisionarían entre manifest entries y memorias locales.

## Plan de implementación recomendado

### Fase 1: Contratos y tipos

Objetivo: cambiar el modelo de tipos para expresar UUIDs como identidad lógica y `fts_id` como detalle de FTS.

Tareas:

- Actualizar tipos de memoria, links, summaries, graph nodes y search results.
- Separar claramente `id: string` de `fts_id: number` en las capas internas.
- Mantener `logs.id: number`.

Criterio de salida:

- El type checker guía todos los lugares que todavía tratan memory IDs como números.

### Fase 2: Schema y migración

Objetivo: introducir schema nuevo y migrar datos existentes de forma segura.

Tareas:

- Añadir migración desde el schema actual.
- Crear UUIDs para espacios y memorias.
- Copiar IDs numéricos legacy a `fts_id`.
- Migrar tags, links y FTS.
- Inicializar secuencia de `fts_id`.

Criterio de salida:

- Una base v7 migra sin pérdida, con `foreign_key_check` limpio y FTS funcional.

### Fase 3: Repositorios y búsqueda

Objetivo: hacer que las operaciones principales funcionen con UUIDs.

Tareas:

- Actualizar CRUD de espacios y memorias.
- Actualizar tags, links, tiers, pinning y access tracking.
- Actualizar FTS insert/update/delete/search para usar `fts_id`.
- Mantener resultados públicos con UUID o nombre según corresponda.

Criterio de salida:

- Tests de store y búsqueda pasan con IDs UUID.

### Fase 4: CLI, MCP, API y checkpoints

Objetivo: preservar contratos públicos mientras se actualiza la identidad interna.

Tareas:

- Mantener comandos CLI por nombre.
- Mantener MCP por referencia nominal.
- Ajustar handlers y schemas internos sin cambiar el contrato externo.
- Ajustar checkpoints y recovery packs.

Criterio de salida:

- Tests CLI, MCP y API pasan sin exigir UUIDs al usuario.

### Fase 5: Autosync manifest v3

Objetivo: eliminar la dependencia de IDs numéricos locales para sync.

Tareas:

- Añadir tipos de manifest v3.
- Escribir v3 en export.
- Leer v2 y migrar a v3.
- Resolver manifests legacy por nombre y hints locales.
- Actualizar status diagnostics.

Criterio de salida:

- Autosync no asocia una entry extranjera a una memoria local incorrecta por colisión numérica.

### Fase 6: Web y verificación final

Objetivo: adaptar consumidores frontend y validar el sistema completo.

Tareas:

- Tratar IDs como strings en web.
- Ajustar mapa neural y paneles.
- Actualizar documentación y changelog si se implementa el cambio.
- Ejecutar verificación completa.

Criterio de salida:

- Tests backend, web y sync pasan.

## Estrategia de pruebas

La implementación debe seguir TDD.

Cobertura mínima:

- Migración v7 a nuevo schema preserva memorias, espacios, tags y links.
- `memories.id` es UUID y `memories.fts_id` es entero único.
- FTS encuentra memorias después de migrar.
- Crear memoria asigna UUID y `fts_id` nuevo desde secuencia.
- Borrar memoria elimina tags, links y entrada FTS.
- `logs.id` sigue numérico.
- Logs históricos con payloads numéricos se leen sin transformación.
- Nuevos logs usan UUID donde corresponda.
- MCP sigue resolviendo por `space/name`.
- CLI no introduce argumentos UUID obligatorios.
- Manifest v3 se escribe con UUID.
- Manifest v2 se lee y migra sin colisión por ID numérico.
- Web acepta IDs string en listas y mapa neural.

Comandos esperados durante implementación:

```bash
bun test test/ web/test
```

Si el cambio modifica documentación pública o arquitectura, también se debe actualizar `AGENTS.md`, `CHANGELOG.md` y, si aplica, `README.md`.

## Riesgos y mitigaciones

### Riesgo: inconsistencia FTS

Si `memories_fts.rowid` deja de coincidir con `memories.fts_id`, la búsqueda puede devolver resultados incorrectos.

Mitigación:

- Reconstruir FTS durante la migración.
- Añadir tests que unan `memories_fts.rowid` contra `memories.fts_id`.
- Validar insert, update, delete y rebuild.

### Riesgo: ruptura de contratos MCP o CLI

Cambiar IDs internos puede filtrarse a usuarios o agentes.

Mitigación:

- Mantener contratos por nombre y referencia.
- Añadir tests MCP/CLI que usen solo nombres.
- No requerir UUID en inputs públicos.

### Riesgo: logs históricos ambiguos

Payloads antiguos pueden contener números que ya no son IDs primarios.

Mitigación:

- Documentar que logs históricos son evidencia legacy.
- No reescribir JSON histórico.
- Usar UUIDs solo en logs nuevos.

### Riesgo: manifest v2 en instalaciones existentes

Instalaciones con manifest v2 deben poder seguir sincronizando.

Mitigación:

- Implementar lector v2.
- Migrar a v3 en la siguiente exportación controlada.
- Tratar IDs numéricos v2 como hints, no como identidad estable.

## Criterios de aceptación del cambio completo

El cambio implementado se considera aceptado cuando:

- Las memorias usan UUID como ID primario real.
- Los espacios usan UUID como ID primario real y `name` permanece único.
- `memories` referencia espacios por `space_id`.
- `fts_id` existe, es entero, único, local y se usa como `rowid` de FTS5.
- La secuencia de `fts_id` asigna valores nuevos transaccionalmente.
- `logs.id` permanece numérico.
- Los logs históricos siguen legibles sin migrar sus JSON payloads.
- Los logs nuevos usan UUIDs donde referencian entidades migradas.
- MCP conserva su contrato por nombre y referencia.
- CLI conserva su contrato de usuario.
- Autosync escribe manifest v3.
- Autosync puede leer manifest v2 durante transición.
- La web funciona con IDs string.
- La búsqueda FTS funciona después de migración, creación, edición y borrado.
- La suite de tests relevante pasa.

## Plan de skills y handoff

### Research

Agente recomendado: `nas_researcher`.

Skills asignadas:

- `mind-management`
- `docs-writer`
- `clean-architecture`
- `bun-development`

Responsabilidad:

- Validar restricciones técnicas.
- Confirmar comportamiento de SQLite FTS5.
- Identificar superficies impactadas.

### Planning

Agente recomendado: `nas_planner`.

Skills asignadas:

- `mind-management`
- `docs-writer`
- `clean-architecture`
- `IADEV-writing-implementation`

Responsabilidad:

- Convertir investigación y decisiones confirmadas en este CR.
- Preparar plan implementable.
- Mantener el alcance explícito.

### Development

Agente futuro recomendado: `nas_developer`.

Skills asignadas:

- `mind-management`
- `docs-writer`
- `bun-development`
- `clean-code`
- `IADEV-test-driven-development`
- `IADEV-code-quality`

Responsabilidad:

- Implementar bajo TDD.
- Actualizar tests y documentación.
- Preservar contratos públicos.

### QA

Agente futuro recomendado: `nas_qa`.

Skills asignadas:

- `mind-management`
- `docs-writer`
- `IADEV-validating-implementation`
- `IADEV-testing-strategy`

Responsabilidad:

- Validar migración real.
- Reejecutar pruebas.
- Auditar que MCP, CLI, web y sync preserven contratos.

## Próximos pasos

1. Aprobar este Change Request.
2. Crear el archivo en `docs/change-requests/`.
3. Convertir el CR aprobado en un plan de implementación TDD.
4. Implementar por fases, empezando por tipos y migración.
