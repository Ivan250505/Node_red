# Guía de Git — Bultos Web

Guía básica para clonar, actualizar y subir cambios al repo `Node_red`. Pensada para alguien que nunca ha usado Git o casi no lo ha usado.

Repo: `https://github.com/Ivan250505/Node_red.git`

## 1. Instalar Git

Si no está instalado: descargar de https://git-scm.com/downloads e instalar con las opciones por defecto. Para comprobar que quedó instalado:

```powershell
git --version
```

## 2. Configurar quién sos (una sola vez por PC)

Git necesita saber nombre y correo para firmar los commits:

```powershell
git config --global user.name "Tu Nombre"
git config --global user.email "tu-correo@ejemplo.com"
```

## 3. Acceso al repositorio

El repo es de la cuenta `Ivan250505`. Para poder hacer `push` (subir cambios), la persona necesita que la agreguen como **colaborador**:

GitHub → repo `Node_red` → **Settings** → **Collaborators** → **Add people** → buscar su usuario/correo de GitHub y agregarlo. La persona debe aceptar la invitación (le llega por correo o le aparece en GitHub).

Sin esto puede clonar y hacer `pull` si el repo es público, pero **no** podrá hacer `push`.

### Autenticación

GitHub ya no acepta usuario+contraseña normal por HTTPS. Al primer `push` (o `pull` en repo privado) va a pedir credenciales. Opciones:

- **Personal Access Token (recomendado, más simple)**: GitHub → foto de perfil → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token**, marcar el permiso `repo`, copiar el token. Cuando Git pida contraseña, pegar el token (no la contraseña real de la cuenta).
- **SSH**: generar una llave con `ssh-keygen`, agregar la llave pública en GitHub → Settings → SSH and GPG keys, y clonar con la URL `git@github.com:...` en vez de `https://...`. Evita escribir credenciales cada vez.

## 4. Clonar el repo (primera vez)

```powershell
git clone https://github.com/Ivan250505/Node_red.git
cd Node_red
```

Esto descarga todo el proyecto con su historial y deja la carpeta lista en la rama `main`.

Después de clonar, seguir el punto 4 de `DOCUMENTACION.md` para crear el `.env` (no viene incluido en el repo).

## 5. Traer cambios nuevos (`pull`)

Cada vez que se vaya a trabajar, **antes** de tocar código:

```powershell
git pull
```

Esto trae los commits que otros hayan subido y los mezcla con lo que hay en la carpeta local.

## 6. Ver qué cambió

```powershell
git status      # qué archivos están modificados/nuevos
git diff        # el detalle línea por línea de lo modificado
```

## 7. Guardar cambios (`commit`)

```powershell
git add archivo1.js archivo2.js     # agregar archivos puntuales
git add .                           # o agregar todo lo modificado/nuevo
git commit -m "Descripción corta de qué se hizo y por qué"
```

`git add .` agrega todo lo que aparece en `git status`, así que conviene revisar antes que no se cuele algo que no debería subirse (por ejemplo un `.env` con contraseñas reales, si por error no está en `.gitignore`).

## 8. Subir los cambios (`push`)

```powershell
git push
```

Si Git responde que la rama remota tiene commits que no se tienen localmente, primero hay que traerlos:

```powershell
git pull
git push
```

## 9. Flujo típico de trabajo diario

```powershell
git pull                          # 1. traer lo último antes de empezar
# ... editar archivos ...
git status                        # 2. revisar qué cambió
git add .                         # 3. preparar los cambios
git commit -m "Descripción"       # 4. guardarlos localmente
git pull                          # 5. traer de nuevo por si alguien subió algo mientras tanto
git push                          # 6. subir
```

## 10. Conflictos

Un conflicto pasa cuando dos personas modificaron las mismas líneas de un archivo. `git pull` avisa cuáles archivos quedaron en conflicto y los marca así:

```
<<<<<<< HEAD
tu versión
=======
la versión que vino del pull
>>>>>>> origin/main
```

Hay que editar el archivo a mano, decidir qué queda (borrando las marcas `<<<<<<<`, `=======`, `>>>>>>>`), y luego:

```powershell
git add archivo_con_conflicto.js
git commit
git push
```

## 11. Comandos útiles adicionales

```powershell
git log --oneline          # historial de commits, resumido
git log --oneline -10      # solo los últimos 10
git branch                 # ver en qué rama se está (normalmente "main")
git stash                  # guardar cambios sin commitear "a un lado" temporalmente
git stash pop              # recuperar esos cambios guardados
git checkout -- archivo.js # descartar cambios locales de un archivo (¡no se puede deshacer!)
```

## 12. Errores comunes

- **"Please tell me who you are"**: falta configurar `user.name`/`user.email` (ver punto 2).
- **"Permission denied" / "403" al hacer push**: la persona no está agregada como colaborador, o está usando la contraseña normal en vez del token (ver punto 3).
- **"Updates were rejected because the remote contains work that you do not have locally"**: hay que hacer `git pull` antes de `git push`.
- **Un archivo `.env` apareció en `git status`**: no debería subirse (tiene datos de conexión reales). Verificar que `.gitignore` incluya `.env`; si ya se subió por error, avisar antes de seguir para sacarlo del historial.
