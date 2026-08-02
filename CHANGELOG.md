# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.1] - 2026-08-03

### Added
- k6 load test suite: 5 scenarios covering API query matrix (batch vs JOIN), mixed workload (60% light / 25% medium / 10% heavy / 5% writes), event publishing, auth registration and login.
- Seed SQL scripts for 200 posts, 10 categories, 30 tags, 5 accounts, 928 post-tag links.
- `load-tests/results.md` with benchmark results: 128.7 req/s mixed workload, p(95)=13.2ms, 0% failure rate on read endpoints.

## [2.0.0] - 2026-08-03

### Stack v2 alignment
- Nginx reverse proxy + Docker Compose orchestration
- Clone-all scripts (clone-all.ps1, clone-all.sh)
- Compose for all 7 services + PostgreSQL + Redis
- CI test summary (670 tests across 6 services)
