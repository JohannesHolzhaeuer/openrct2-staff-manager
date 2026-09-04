# Changelog

## [0.13.0](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/compare/v0.12.0...v0.13.0) (2026-09-04)


### Features

* **ui:** add section icons and separators to window layout ([#42](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/42)) ([dbada6b](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/dbada6b4a7cb29de61f21617858f57a49434922e))


### Bug Fixes

* stop npm install hitting retired audit endpoint ([#46](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/46)) ([d22a0ae](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/d22a0ae4c1e84a694ee13d6b514c324715ae5d05))


### Documentation

* update README and screenshot for new UI/workflow ([#44](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/44)) ([e7276b7](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/e7276b7487863156346a35bdf5c2e8df54f4c536))

## [0.12.0](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/compare/v0.11.0...v0.12.0) (2026-09-03)


### Features

* add ride exit and owned tile counts to top status line ([#25](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/25)) ([1f2dddf](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/1f2dddf3b249874ddc7694099f73b5bf3b1a9794))
* adopt release-please, commitlint, and husky for automated releases ([#10](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/10)) ([15145de](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/15145defe4b065bb7aff98006f082eeb38b793c0))


### Bug Fixes

* add git usr/bin PATH fallback to commit-msg hook ([#24](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/24)) ([dcfa50e](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/dcfa50e898a2db45bd058ecdd6a6f04984d3bd7b))
* avoid teleporting staff onto tiles with small scenery (e.g. trees) ([#14](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/14)) ([c7555e6](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/c7555e6b2f7349bd8fc05f86222ae94021e9e3f8))
* checkout release commit sha instead of draft-only tag ref in publish-release ([#17](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/17)) ([4642031](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/46420317952fa5de017038671fd588d836be579d))
* correct tab indentation in ci.yml causing invalid workflow ([#13](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/13)) ([d8f3819](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/d8f3819aaecdb67ebae4c1d5cc4f674c8b03beb3))
* drop package prefix from release tag and title ([#38](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/38)) ([1c7a181](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/1c7a181e7a8877f646e4ce266c3183e715c2e1a1))
* name releases/tags just vX.Y.Z instead of staff-manager-vX.Y.Z ([#26](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/26)) ([eac028b](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/eac028bdb857f73e9a93509b79578f2a1a7a29b8))


### Performance Improvements

* index area tiles for O(1) coverage and adjacency lookups ([#29](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/29)) ([ee7c88f](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/ee7c88f187370a7f0b062c3bf0217b689983c3e5))
* remove redundant tile work from map scans ([#28](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/28)) ([21333b3](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/21333b3c8fe2c78e74dcbd2e5e12c1efd3b166f0))
* spread the gardening sweep across game ticks ([#33](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/33)) ([2c93b08](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/2c93b084a4242429a1e36acf5238fa250547b4a9))


### Code Refactoring

* make map access injectable for testing ([#35](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/35)) ([c1edd7a](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/c1edd7a7cd9afa0ed1bbd13f1188b242462400c2))
* make scheduling and hire/fire flows injectable ([#37](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/37)) ([635bf7c](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/635bf7ce7c21a3a5313c82beae8158a7ec7e1d7e))
* remove unused 'assigned' param, enforce TS checks ([732dcba](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/732dcbaee5e1c1d9a4dc988f80d66ba659fb4766))
* route staff module map reads through the game seam ([#36](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/36)) ([a22cb81](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/a22cb81d9deb7048a4a2ac3ecf1ae36e8010e9bb))
* split auto-mode logic out of the staff module ([#34](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/34)) ([bedb221](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/bedb221ad116e1a72aff5078b8a9a750f41a0eee))


### Documentation

* add PR template and CI/release badges to README ([#11](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/11)) ([490a555](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/490a555769b6e9b57193896f3b742bb8ea3fadbb))


### Build System

* split verify out of build for a faster dev loop ([#31](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/31)) ([8f32103](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/8f32103dfa61e99dbcc6e82260057226d604f039))

## [0.11.0](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/compare/staff-manager-v0.10.0...staff-manager-v0.11.0) (2026-09-03)


### Features

* add ride exit and owned tile counts to top status line ([#25](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/25)) ([1f2dddf](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/1f2dddf3b249874ddc7694099f73b5bf3b1a9794))


### Bug Fixes

* add git usr/bin PATH fallback to commit-msg hook ([#24](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/24)) ([dcfa50e](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/dcfa50e898a2db45bd058ecdd6a6f04984d3bd7b))
* name releases/tags just vX.Y.Z instead of staff-manager-vX.Y.Z ([#26](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/26)) ([eac028b](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/eac028bdb857f73e9a93509b79578f2a1a7a29b8))

## [0.10.0](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/compare/staff-manager-v0.9.5...staff-manager-v0.10.0) (2026-09-03)


### Features

* adopt release-please, commitlint, and husky for automated releases ([#10](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/10)) ([15145de](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/15145defe4b065bb7aff98006f082eeb38b793c0))


### Bug Fixes

* avoid teleporting staff onto tiles with small scenery (e.g. trees) ([#14](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/14)) ([c7555e6](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/c7555e6b2f7349bd8fc05f86222ae94021e9e3f8))
* checkout release commit sha instead of draft-only tag ref in publish-release ([#17](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/17)) ([4642031](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/46420317952fa5de017038671fd588d836be579d))
* correct tab indentation in ci.yml causing invalid workflow ([#13](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/13)) ([d8f3819](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/d8f3819aaecdb67ebae4c1d5cc4f674c8b03beb3))


### Code Refactoring

* remove unused 'assigned' param, enforce TS checks ([732dcba](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/732dcbaee5e1c1d9a4dc988f80d66ba659fb4766))


### Documentation

* add PR template and CI/release badges to README ([#11](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/issues/11)) ([490a555](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/commit/490a555769b6e9b57193896f3b742bb8ea3fadbb))

## Changelog
