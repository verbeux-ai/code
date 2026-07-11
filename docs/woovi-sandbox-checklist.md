# Checklist manual: compra Woovi no CLI

Use uma conta de teste e configure o backend com a chave e a URL sandbox da
Woovi fora do repositório. Nunca use CPF, telefone ou credenciais reais.

1. Crie e publique um grupo somente Stripe, um somente Woovi e um com os dois
   provedores; registre o preço, a moeda e o intervalo de cada um.
2. Entre no CLI com uma conta sem modelos e confirme que o plano Stripe abre o
   checkout no navegador e libera os modelos após a confirmação.
3. No plano Woovi, informe um CPF de teste válido e um celular com DDD. Confirme
   que o terminal mostra o QR Code e o código Pix copia-e-cola.
4. Aprove o mandato Pix no ambiente de teste e confirme o recebimento do
   webhook `PIX_AUTOMATIC_APPROVED`/`COBR_COMPLETED`; o CLI deve detectar a
   assinatura ativa e liberar os modelos sem ser reiniciado.
5. Feche o CLI antes da aprovação e reabra-o. Refaça a compra e verifique que o
   mesmo QR pendente é exibido, sem nova assinatura Woovi.
6. No plano com ambos provedores, valide os dois caminhos: cartão Stripe e Pix
   Automático. Verifique também CPF inválido, telefone inválido, timeout do QR
   e cancelamento de uma assinatura Pix ainda no período pago.
