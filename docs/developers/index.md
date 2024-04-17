# Integrating with CRMs using the Unified CRM extension framework

Welcome to RingCentral's Unified CRM integration framework. Using this framework, developers can integrate RingCentral into their web-based CRM more easily. The framework is centered around enabling the following user interactions common to many CRM integrations:

* **Embedded phone**. Injecting a phone into the CRM for a fully-integrated communications experience.
* **Call pop**. Automatically opening up a contact record when a call is received.
* **Logging calls**. Capturing and storing call notes in an activity record linked to an associated contact in the CRM.

The Unified CRM integration framework is build on top of [RingCentral Embeddable](https://ringcentral.github.io/ringcentral-embeddable/), which itself provides the following capabilities via its unified communications client:

* Make and receive phone calls.
* Send and receive SMS.
* Read and send team chat messages. 
* Search your RingCentral address book.
* View a history of past calls.
* Listen to call recordings.
* Access and listen to voicemail. 

Each CRM supported by this framework is required to implement what is referred to as an "adapter." Each adapter implements two different components:

* A Javascript plugin that implements CRM-specific functionality that is invoked by the front-end client. This plugin is then packaged with the framework and RingCentral Embeddable as a Google Chrome extension. 
* A small server that implements a prescribed interface that is invoked by the front-end client to perform more complex interactions with the CRM. 

In this guide, you will learn how to build, package and distribute an adapter for a CRM.
