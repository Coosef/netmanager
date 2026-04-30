.PHONY: up down logs ps restart build

up:
	docker compose up -d

down:
	docker compose down

build:
	docker compose build

logs:
	docker compose logs -f backend celery_worker

ps:
	docker compose ps

restart-backend:
	docker compose restart backend celery_worker

shell-backend:
	docker compose exec backend bash

db-shell:
	docker compose exec postgres psql -U netmgr -d network_manager
