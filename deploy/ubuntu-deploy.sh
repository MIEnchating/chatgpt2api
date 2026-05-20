#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Usage:
  sh deploy/ubuntu-deploy.sh [deploy|pull|restart|logs|status]

Default command:
  deploy

Environment variables:
  CHATGPT2API_REPO_URL        Git repository URL.
                              Default: https://github.com/MIEnchating/chatgpt2api.git
  CHATGPT2API_BRANCH          Git branch to deploy. Default: main
  CHATGPT2API_INSTALL_DIR     Install directory. Default: current repo when run inside one,
                              otherwise /opt/chatgpt2api
  CHATGPT2API_DOCKER_NETWORK  Docker network to join. Default: newapi_default
  CHATGPT2API_IMAGE           Runtime image. Default: zyphrzero/chatgpt2api:latest
  CHATGPT2API_BUILD_LOCAL     Set to 1/true/yes to build from local source with
                              deploy/docker-build-limited.sh.
  CHATGPT2API_COMPOSE_PROJECT Docker Compose project name. Default: chatgpt2api

Optional first-run settings:
  CHATGPT2API_ADMIN_USERNAME
  CHATGPT2API_ADMIN_PASSWORD
  CHATGPT2API_RELAY_BASE_URL
  CHATGPT2API_IMAGE

Examples:
  curl -fsSL https://raw.githubusercontent.com/MIEnchating/chatgpt2api/main/deploy/ubuntu-deploy.sh | sudo sh
  curl -fsSL https://raw.githubusercontent.com/MIEnchating/chatgpt2api/main/deploy/ubuntu-deploy.sh | sudo sh -s -- deploy
  curl -fsSL https://raw.githubusercontent.com/MIEnchating/chatgpt2api/main/deploy/ubuntu-deploy.sh | sudo env CHATGPT2API_ADMIN_PASSWORD='change_me' sh
  sh deploy/ubuntu-deploy.sh deploy
  CHATGPT2API_ADMIN_PASSWORD='change_me' sh deploy/ubuntu-deploy.sh deploy
  CHATGPT2API_BUILD_LOCAL=1 sh deploy/ubuntu-deploy.sh deploy
  sh deploy/ubuntu-deploy.sh logs
EOF
}

log() {
  printf '%s\n' "==> $*"
}

warn() {
  printf '%s\n' "WARN: $*" >&2
}

die() {
  printf '%s\n' "ERROR: $*" >&2
  exit 1
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi
  command -v sudo >/dev/null 2>&1 || die "sudo is required when not running as root"
  sudo "$@"
}

docker_cmd() {
  if [ "$(id -u)" -eq 0 ]; then
    docker "$@"
    return
  fi
  if docker info >/dev/null 2>&1; then
    docker "$@"
    return
  fi
  as_root docker "$@"
}

run_git() {
  if [ "$(id -u)" -eq 0 ] || [ -w "$install_dir" ] || [ ! -e "$install_dir" ]; then
    git "$@"
    return
  fi
  as_root git "$@"
}

truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

detect_install_dir() {
  if [ -n "${CHATGPT2API_INSTALL_DIR:-}" ]; then
    printf '%s\n' "$CHATGPT2API_INSTALL_DIR"
    return
  fi

  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  candidate_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
  if [ -d "$candidate_root/.git" ]; then
    printf '%s\n' "$candidate_root"
    return
  fi

  printf '%s\n' "/opt/chatgpt2api"
}

install_base_packages() {
  command -v apt-get >/dev/null 2>&1 || die "This script expects Ubuntu/Debian with apt-get"
  log "Installing base packages"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git openssl
}

install_docker_if_needed() {
  if command -v docker >/dev/null 2>&1; then
    return
  fi

  log "Installing Docker"
  tmp_script=$(mktemp)
  curl -fsSL https://get.docker.com -o "$tmp_script"
  as_root sh "$tmp_script"
  rm -f "$tmp_script"
}

start_docker() {
  if command -v systemctl >/dev/null 2>&1; then
    as_root systemctl enable --now docker >/dev/null 2>&1 || as_root systemctl start docker
    return
  fi
  as_root service docker start >/dev/null 2>&1 || true
}

require_docker_compose() {
  if docker_cmd compose version >/dev/null 2>&1; then
    return
  fi

  log "Installing Docker Compose plugin"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin
  docker_cmd compose version >/dev/null 2>&1 || die "docker compose plugin is not available"
}

prepare_system() {
  if [ -r /etc/os-release ] && ! grep -qiE 'ubuntu|debian' /etc/os-release; then
    warn "This script is designed for Ubuntu/Debian. Continuing anyway."
  fi

  install_base_packages
  install_docker_if_needed
  start_docker
  require_docker_compose
}

clone_or_update_repo() {
  repo_url="${CHATGPT2API_REPO_URL:-https://github.com/MIEnchating/chatgpt2api.git}"
  branch="${CHATGPT2API_BRANCH:-main}"

  if [ -d "$install_dir/.git" ]; then
    log "Updating repository: $install_dir"
    run_git -C "$install_dir" fetch origin "$branch"
    run_git -C "$install_dir" checkout "$branch"
    run_git -C "$install_dir" pull --ff-only origin "$branch"
    return
  fi

  if [ -e "$install_dir" ] && [ "$(find "$install_dir" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')" != "0" ]; then
    die "$install_dir exists but is not an empty git repository"
  fi

  log "Cloning repository to $install_dir"
  as_root mkdir -p "$(dirname -- "$install_dir")"
  if [ "$(id -u)" -eq 0 ] || [ -w "$(dirname -- "$install_dir")" ]; then
    git clone --branch "$branch" "$repo_url" "$install_dir"
  else
    as_root git clone --branch "$branch" "$repo_url" "$install_dir"
  fi
}

write_file_from_temp() {
  tmp_file="$1"
  target_file="$2"
  if [ -e "$target_file" ] && [ -w "$target_file" ]; then
    mv "$tmp_file" "$target_file"
    return
  fi
  if [ ! -e "$target_file" ] && [ -w "$(dirname -- "$target_file")" ]; then
    mv "$tmp_file" "$target_file"
    return
  fi
  as_root cp "$tmp_file" "$target_file"
  rm -f "$tmp_file"
}

set_env_value() {
  key="$1"
  value="$2"
  file="$3"
  tmp_file=$(mktemp)
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ "^[[:space:]]*#?[[:space:]]*" key "=" {
      if (!done) {
        print key "=" value
        done = 1
      }
      next
    }
    { print }
    END {
      if (!done) {
        print key "=" value
      }
    }
  ' "$file" > "$tmp_file"
  write_file_from_temp "$tmp_file" "$file"
}

generate_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 24 | tr -d '\n'
    return
  fi
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

prepare_env_file() {
  env_file="$install_dir/.env"
  env_example="$install_dir/.env.example"
  generated_admin_password=""
  new_env=0

  if [ ! -f "$env_file" ]; then
    log "Creating .env"
    if [ -f "$env_example" ]; then
      tmp_file=$(mktemp)
      cp "$env_example" "$tmp_file"
      write_file_from_temp "$tmp_file" "$env_file"
    else
      tmp_file=$(mktemp)
      : > "$tmp_file"
      write_file_from_temp "$tmp_file" "$env_file"
    fi
    new_env=1
  fi

  if [ "$new_env" -eq 1 ]; then
    set_env_value CHATGPT2API_ADMIN_USERNAME "${CHATGPT2API_ADMIN_USERNAME:-admin}" "$env_file"
    if [ -n "${CHATGPT2API_ADMIN_PASSWORD:-}" ]; then
      set_env_value CHATGPT2API_ADMIN_PASSWORD "$CHATGPT2API_ADMIN_PASSWORD" "$env_file"
    else
      generated_admin_password=$(generate_password)
      set_env_value CHATGPT2API_ADMIN_PASSWORD "$generated_admin_password" "$env_file"
    fi
    set_env_value CHATGPT2API_REGISTRATION_ENABLED "${CHATGPT2API_REGISTRATION_ENABLED:-true}" "$env_file"
    set_env_value CHATGPT2API_RELAY_BASE_URL "${CHATGPT2API_RELAY_BASE_URL:-http://newapi:3000}" "$env_file"
    set_env_value CHATGPT2API_DOCKER_NETWORK "${CHATGPT2API_DOCKER_NETWORK:-newapi_default}" "$env_file"
    set_env_value STORAGE_BACKEND "${STORAGE_BACKEND:-sqlite}" "$env_file"
    [ "${CHATGPT2API_IMAGE+x}" = "x" ] && set_env_value CHATGPT2API_IMAGE "$CHATGPT2API_IMAGE" "$env_file"
    [ "${CHATGPT2API_PULL_POLICY+x}" = "x" ] && set_env_value CHATGPT2API_PULL_POLICY "$CHATGPT2API_PULL_POLICY" "$env_file"
  else
    [ "${CHATGPT2API_ADMIN_USERNAME+x}" = "x" ] && set_env_value CHATGPT2API_ADMIN_USERNAME "$CHATGPT2API_ADMIN_USERNAME" "$env_file"
    [ "${CHATGPT2API_ADMIN_PASSWORD+x}" = "x" ] && set_env_value CHATGPT2API_ADMIN_PASSWORD "$CHATGPT2API_ADMIN_PASSWORD" "$env_file"
    [ "${CHATGPT2API_REGISTRATION_ENABLED+x}" = "x" ] && set_env_value CHATGPT2API_REGISTRATION_ENABLED "$CHATGPT2API_REGISTRATION_ENABLED" "$env_file"
    [ "${CHATGPT2API_RELAY_BASE_URL+x}" = "x" ] && set_env_value CHATGPT2API_RELAY_BASE_URL "$CHATGPT2API_RELAY_BASE_URL" "$env_file"
    [ "${CHATGPT2API_DOCKER_NETWORK+x}" = "x" ] && set_env_value CHATGPT2API_DOCKER_NETWORK "$CHATGPT2API_DOCKER_NETWORK" "$env_file"
    [ "${STORAGE_BACKEND+x}" = "x" ] && set_env_value STORAGE_BACKEND "$STORAGE_BACKEND" "$env_file"
    [ "${CHATGPT2API_IMAGE+x}" = "x" ] && set_env_value CHATGPT2API_IMAGE "$CHATGPT2API_IMAGE" "$env_file"
    [ "${CHATGPT2API_PULL_POLICY+x}" = "x" ] && set_env_value CHATGPT2API_PULL_POLICY "$CHATGPT2API_PULL_POLICY" "$env_file"
  fi

  as_root mkdir -p "$install_dir/data"
}

env_value() {
  key="$1"
  file="$2"
  awk -F= -v key="$key" '
    $0 ~ "^[[:space:]]*" key "=" {
      sub("^[[:space:]]*" key "=", "")
      print
      exit
    }
  ' "$file"
}

ensure_docker_network() {
  env_file="$install_dir/.env"
  network="${CHATGPT2API_DOCKER_NETWORK:-$(env_value CHATGPT2API_DOCKER_NETWORK "$env_file")}"
  network="${network:-newapi_default}"

  if docker_cmd network inspect "$network" >/dev/null 2>&1; then
    log "Docker network exists: $network"
    return
  fi

  warn "Docker network $network does not exist. Creating it as a bridge network."
  docker_cmd network create "$network" >/dev/null
}

compose() {
  docker_cmd compose --project-name "${CHATGPT2API_COMPOSE_PROJECT:-chatgpt2api}" --env-file "$install_dir/.env" -f "$install_dir/deploy/docker-compose.yml" "$@"
}

remove_conflicting_container() {
  container_id=$(docker_cmd ps -aq --filter "name=^/chatgpt2api$" | head -n 1 || true)
  if [ -z "$container_id" ]; then
    return
  fi

  project_label=$(docker_cmd inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$container_id" 2>/dev/null || true)
  service_label=$(docker_cmd inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$container_id" 2>/dev/null || true)
  expected_project="${CHATGPT2API_COMPOSE_PROJECT:-chatgpt2api}"

  if [ "$project_label" = "$expected_project" ] && [ "$service_label" = "chatgpt2api" ]; then
    return
  fi

  warn "Removing existing container named chatgpt2api before deployment"
  warn "Old container id: $container_id project=${project_label:-none} service=${service_label:-none}"
  docker_cmd rm -f "$container_id" >/dev/null
}

deploy_service() {
  ensure_docker_network
  remove_conflicting_container

  if truthy "${CHATGPT2API_BUILD_LOCAL:-}"; then
    log "Building and starting local image"
    (cd "$install_dir" && sh deploy/docker-build-limited.sh up)
  else
    log "Pulling runtime image"
    compose pull
    log "Starting service"
    compose up -d
  fi
}

wait_for_health() {
  container_name=chatgpt2api
  attempt=1
  while [ "$attempt" -le 30 ]; do
    status=$(docker_cmd inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_name" 2>/dev/null || true)
    case "$status" in
      healthy|running)
        log "Service is $status"
        return
        ;;
      unhealthy|exited|dead)
        docker_cmd logs --tail 80 "$container_name" || true
        die "Service is $status"
        ;;
    esac
    sleep 2
    attempt=$((attempt + 1))
  done

  docker_cmd logs --tail 80 "$container_name" || true
  die "Timed out waiting for service health"
}

print_summary() {
  env_file="$install_dir/.env"
  network="${CHATGPT2API_DOCKER_NETWORK:-$(env_value CHATGPT2API_DOCKER_NETWORK "$env_file")}"
  network="${network:-newapi_default}"

  cat <<EOF

Deployment complete.
  install dir: $install_dir
  compose:     $install_dir/deploy/docker-compose.yml
  env file:    $env_file
  data dir:    $install_dir/data
  container:   chatgpt2api
  network:     $network

The compose file does not publish ports. Put your reverse proxy on the same
Docker network and proxy to:
  http://chatgpt2api:80
EOF

  if [ -n "${generated_admin_password:-}" ]; then
    cat <<EOF

Generated first-run admin account:
  username: $(env_value CHATGPT2API_ADMIN_USERNAME "$env_file")
  password: $generated_admin_password
EOF
  fi
}

command_name="${1:-deploy}"
case "$command_name" in
  deploy|pull|restart|logs|status)
    ;;
  -h|--help|help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

install_dir=$(detect_install_dir)

case "$command_name" in
  deploy)
    prepare_system
    clone_or_update_repo
    prepare_env_file
    deploy_service
    wait_for_health
    print_summary
    ;;
  pull)
    prepare_system
    clone_or_update_repo
    prepare_env_file
    deploy_service
    wait_for_health
    ;;
  restart)
    prepare_system
    [ -f "$install_dir/deploy/docker-compose.yml" ] || die "compose file not found under $install_dir"
    ensure_docker_network
    compose up -d
    wait_for_health
    ;;
  logs)
    [ -f "$install_dir/deploy/docker-compose.yml" ] || die "compose file not found under $install_dir"
    compose logs -f --tail 100 chatgpt2api
    ;;
  status)
    [ -f "$install_dir/deploy/docker-compose.yml" ] || die "compose file not found under $install_dir"
    compose ps
    ;;
esac
