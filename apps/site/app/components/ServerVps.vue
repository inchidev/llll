<template>
    <section class="space-y-6">
      <h2 class="text-2xl font-semibold">celld + Docker Compose</h2>
      <p class="text-muted">
        Run one independent Server on your VPS with Docker Compose or Coolify,
        then configure HTTPS.
      </p>
      <pre
        class="overflow-x-auto rounded-lg border border-default p-4 text-xs leading-6"
      >
git clone https://github.com/inchidev/llll.git
cd llll/self-host
cp .env.example .env
# Set your origin, owner email and private secrets in .env
docker compose up -d --build</pre>
      <p class="text-sm text-muted">
        Keep credentials private. Open the owner claim link, set your password,
        then connect the Server address from Shell. Automatic SSH deployment
        is not available yet.
      </p>
      <UButton
        to="https://github.com/inchidev/llll/blob/main/docs/deployment.md"
        label="VPS deployment guide"
        color="neutral"
        variant="outline"
        external
      />
    </section>
</template>
