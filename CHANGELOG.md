# Changelog

## [1.0.1](https://github.com/ViateAI/viate/compare/v1.0.0...v1.0.1) (2026-11-04)


### Bug Fixes

* deploy the server image without refetching metadata ([8906cc4](https://github.com/ViateAI/viate/commit/8906cc4e04f2fb26b2417e9a8e4aa4447d9c510e))

## 1.0.0 (2026-11-04)


### Features

* add a framework-agnostic plugin logger ([ee71c90](https://github.com/ViateAI/viate/commit/ee71c90d1d080333bef5c92adc5311d36b31ff91))
* add async video generation routes ([c5169cc](https://github.com/ViateAI/viate/commit/c5169ccd0c1bc10aaa227720e47f29babde8756f))
* add audio transcription and speech routes ([82b10ca](https://github.com/ViateAI/viate/commit/82b10ca92e2eac7395a32df88ca365d101f9629c))
* add channels that price and limit models ([fea85b8](https://github.com/ViateAI/viate/commit/fea85b8ba0449afb3d572159c981238b07072298))
* add custom models missing from the upstream catalog ([c2fc76a](https://github.com/ViateAI/viate/commit/c2fc76a705067dc85eb58bdbfd813999d37add51))
* add customer accounts, token balances, and a portal ([bea471a](https://github.com/ViateAI/viate/commit/bea471a115d0161786a71a494db7abdc1dd12a84))
* add English and Chinese UI copy ([aa970e9](https://github.com/ViateAI/viate/commit/aa970e984bc77e0030abeb9bb236aef26d1c7ac9))
* add image routes and filtered request statistics ([547e931](https://github.com/ViateAI/viate/commit/547e9318b8b520cf5f8d057fcbcb718c0ea9f353))
* add provider limits and manual model prices ([d6dc4b1](https://github.com/ViateAI/viate/commit/d6dc4b13abb33be4d198a724215404a2a0ee2eb5))
* add request logging, usage accounting, compaction routing, and OAuth UI ([bb9655a](https://github.com/ViateAI/viate/commit/bb9655af16b4efeedd93221849e9d81f918aeff9))
* add the gateway workspace ([8b8a9d1](https://github.com/ViateAI/viate/commit/8b8a9d1aaef7a22bd966c04018f178c84146515c))
* advertise chat and Responses on GET /v1/models ([e89585e](https://github.com/ViateAI/viate/commit/e89585e6356fb1169edf27a8a0bf10929e88908a))
* charge requests in USD and let customers limit models ([64c2e13](https://github.com/ViateAI/viate/commit/64c2e13a49ad4e99a8c026a873290b27f314e820))
* limit channels to an exact model list ([f4be944](https://github.com/ViateAI/viate/commit/f4be9443926592c87b72096cf9db54ec71307fe8))
* load plugins against the host SDK ([5437fa4](https://github.com/ViateAI/viate/commit/5437fa407489434eafbad8c22477bfe5626171c2))
* show each channel ratio on the portal ([7d65b36](https://github.com/ViateAI/viate/commit/7d65b3640843597fcf21e6e363f61dab5207d619))
* show granted models and call examples on the portal ([a105091](https://github.com/ViateAI/viate/commit/a105091e5dddf20eacc8be266e9967d2bcad14e8))
* show upstream subscription usage per connection ([62b49d8](https://github.com/ViateAI/viate/commit/62b49d8f4f8469d84b92721060472e1da99d62c0))
* split the portal into keys, activity, and account ([037a44e](https://github.com/ViateAI/viate/commit/037a44e787d0790cd421846acb6320085bc0749e))
* store endpoint types on each custom model ([dd57402](https://github.com/ViateAI/viate/commit/dd57402078b3f400eaae3bdf79bb2250dbcb4392))


### Bug Fixes

* accept a leading -- in viate commands ([5b9cf69](https://github.com/ViateAI/viate/commit/5b9cf698f4e16a0fddce10dfe3f8d31469571abe))
* bill cache-read tokens at the cache-read price ([b052860](https://github.com/ViateAI/viate/commit/b052860df11f5325def16bbe04558309dda37a74))
* build the SDK before typecheck and test ([8795aef](https://github.com/ViateAI/viate/commit/8795aeff1dedf72abc0ee0eab2b09a789175dc5f))
* keep SSE frames when redacting logged payloads ([0254044](https://github.com/ViateAI/viate/commit/0254044a580d95370b99c3c22f7d17089d3402bc))
* keep the admin model catalog usable for large inventories ([84b7489](https://github.com/ViateAI/viate/commit/84b7489e0d86b39d1efcb6739bc892fccdab107a))
* log the model id sent upstream ([4abde2e](https://github.com/ViateAI/viate/commit/4abde2e19a654cdbf21265a7e0f8682bc7432514))
* read Responses usage from nested response.completed frames ([d8061ee](https://github.com/ViateAI/viate/commit/d8061ee056c2df34cb452326b54ecca57b34d6c9))
* retry upstream 401 and 403 during failover ([a850de0](https://github.com/ViateAI/viate/commit/a850de037042a0ba447b00af92880ecd62eda9b9))
