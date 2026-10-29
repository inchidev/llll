---
title: Server and Shell: why your workspace has two addresses
description: How L4 keeps navigation across Servers separate from each community's identity and permissions.
date: 2026-10-20
author: Inchi
---

You might work with several communities in L4: a team, a local group and a project with friends. The Shell gives you a place to find their Servers. Each Server remains responsible for the workspace you enter.

## The Shell remembers where to go

A Shell bookmark stores a Server connection on your device. It is a navigation aid: removing it takes the shortcut off that device, not the Server or your Account. You can also open a Server directly by its own address.

When you enter a Server from the official Shell, the Shell embeds the Client served by that Server. The Server handles its own sign-in, content and permissions. A saved address cannot make someone a Member or bypass a private Channel.

## A Server can have more than one address

A Server has a persistent UUID. An owner can configure a primary address and additional aliases that reach the same Server. The primary address is used for new links and Shell display; an alias can still lead to the same Accounts and content. The identity is the UUID, not the spelling of the hostname.

Only addresses configured by the Server are trusted. That matters for login, sessions and other requests: a hostname reaching the same Worker is not automatically accepted as an address of the Server.

## What happens when one is unavailable?

An unavailable Server affects that community's workspace; it does not grant or remove access to another. Some browsers, embedding rules and networks behave differently, and we are still testing them on real devices. An operator should check both the direct Client and the Shell on the devices their community uses.

This separation makes the Shell convenient without making it the owner of everyone's work. Your community's Server remains the place that knows its Members and enforces its rules.
