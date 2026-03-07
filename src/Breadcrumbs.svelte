<script lang="ts">
  let { crumbs }: {
    crumbs: { label: string; onclick?: () => void }[];
  } = $props();
</script>

<nav class="breadcrumbs">
  {#each crumbs as crumb, i}
    {#if i > 0}
      <span class="separator">/</span>
    {/if}
    {#if crumb.onclick}
      <button type="button" onclick={crumb.onclick}>{crumb.label}</button>
    {:else}
      <span class="current">{crumb.label}</span>
    {/if}
  {/each}
</nav>

<style>
  .breadcrumbs {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: #888;
    margin-bottom: 0.5rem;
  }

  .separator {
    color: #555;
  }

  .current {
    color: #888;
  }

  button {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    color: #888;
    font-size: 0.85rem;
    font-family: inherit;
    cursor: pointer;
  }

  button:hover {
    color: #ccc;
  }
</style>
